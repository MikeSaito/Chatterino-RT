use std::time::Duration;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::AppHandle;

use super::auth::{self, AuthFail, AuthInfo, DeviceStart};
use super::complete;
use super::filters::{self, Filters};
use super::settings::DisplaySettings;
use super::spans::allowed_chat_url;
use super::state::{BttvCmd, EventCmd, IrcCmd, Shared};
use super::types::ChatBatch;

const MAX_CHAT_CHARS: usize = 500;

#[derive(Debug, Serialize)]
pub struct ApiError {
    pub code: String,
    pub message: String,
}

impl ApiError {
    pub fn internal(msg: &str) -> Self {
        Self {
            code: "internal".into(),
            message: msg.into(),
        }
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self {
            code: "invalid_input".into(),
            message: message.into(),
        }
    }
}

impl From<AuthFail> for ApiError {
    fn from(e: AuthFail) -> Self {
        Self {
            code: e.code,
            message: e.message,
        }
    }
}

#[tauri::command]
pub async fn chat_join(
    app: AppHandle,
    state: tauri::State<'_, Shared>,
    channel: String,
    focus: Option<bool>,
) -> Result<String, ApiError> {
    let normalized = normalize_channel(&channel)?;
    let do_focus = focus.unwrap_or(true);
    let is_new = {
        let hub = state.hub.lock().map_err(|_| ApiError::internal("lock"))?;
        !hub.has_channel(&normalized)
    };
    if is_new {
        super::session::ensure_can_open(&state, &normalized)?;
    }
    if do_focus {
        let switched = {
            let mut hub = state.hub.lock().map_err(|_| ApiError::internal("lock"))?;
            let previous = hub.active.clone();
            hub.set_active(Some(normalized.clone()));
            previous.as_deref() != Some(normalized.as_str())
        };
        if switched {
            state.notify_event(EventCmd::ClearChannel);
            state.notify_bttv(BttvCmd::ClearChannel);
        }
    } else {
        let mut hub = state.hub.lock().map_err(|_| ApiError::internal("lock"))?;
        hub.buffer(&normalized);
    }
    if let Ok(mut set) = state.chatters.lock() {
        set.ensure_channel(&normalized);
        set.add(&normalized, &normalized, &normalized);
    }
    send_cmd(&state, IrcCmd::Join(normalized.clone())).await?;
    let _ = super::session::remember(&state, normalized.clone(), do_focus);
    auth::emit(&app, &state);
    Ok(normalized)
}

#[tauri::command]
pub async fn chat_leave(
    app: AppHandle,
    state: tauri::State<'_, Shared>,
    channel: String,
) -> Result<Option<String>, ApiError> {
    let normalized = normalize_channel(&channel)?;
    let left_was_active = {
        let hub = state.hub.lock().map_err(|_| ApiError::internal("lock"))?;
        hub.active.as_deref() == Some(normalized.as_str())
    };
    send_cmd(&state, IrcCmd::PartChannel(normalized.clone())).await?;
    if left_was_active {
        state.notify_event(EventCmd::ClearChannel);
        state.notify_bttv(BttvCmd::ClearChannel);
    }
    if let Ok(mut cat) = state.catalog.lock() {
        cat.drop_channel(&normalized);
    }
    if let Ok(mut cat) = state.badges.lock() {
        cat.drop_channel(&normalized);
    }
    if let Ok(mut cat) = state.cheers.lock() {
        cat.drop_channel(&normalized);
    }
    if let Ok(mut set) = state.chatters.lock() {
        set.drop_channel(&normalized);
    }
    {
        let mut hub = state.hub.lock().map_err(|_| ApiError::internal("lock"))?;
        hub.drop_channel(&normalized);
    }
    let _ = super::session::forget_open(&state, &normalized);
    let next = if left_was_active {
        super::session::preferred_focus(&state)
    } else {
        state
            .hub
            .lock()
            .ok()
            .and_then(|h| h.active.clone())
    };
    if left_was_active {
        if let Some(ch) = next.as_ref() {
            {
                let mut hub = state.hub.lock().map_err(|_| ApiError::internal("lock"))?;
                hub.set_active(Some(ch.clone()));
            }
            let _ = super::session::remember(&state, ch.clone(), true);
            send_cmd(&state, IrcCmd::Join(ch.clone())).await?;
        } else {
            let _ = super::session::clear_last(&state);
        }
    }
    auth::emit(&app, &state);
    Ok(next)
}

#[tauri::command]
pub async fn chat_part(app: AppHandle, state: tauri::State<'_, Shared>) -> Result<(), ApiError> {
    send_cmd(&state, IrcCmd::Part).await?;
    state.notify_event(EventCmd::ClearChannel);
    state.notify_bttv(BttvCmd::ClearChannel);
    {
        let mut hub = state.hub.lock().map_err(|_| ApiError::internal("lock"))?;
        hub.clear_all();
    }
    if let Ok(mut cat) = state.catalog.lock() {
        cat.clear_channels();
    }
    if let Ok(mut cat) = state.badges.lock() {
        cat.clear_channels();
    }
    if let Ok(mut cat) = state.cheers.lock() {
        cat.clear_channels();
    }
    if let Ok(mut set) = state.chatters.lock() {
        set.clear();
    }
    let _ = super::session::clear_last(&state);
    auth::emit(&app, &state);
    Ok(())
}

#[tauri::command]
pub fn chat_subscribe(
    state: tauri::State<'_, Shared>,
    channel: Channel<Vec<u8>>,
) -> Result<(), ApiError> {
    state
        .set_batch_channel(channel)
        .map_err(|_| ApiError::internal("lock"))
}

#[tauri::command]
pub fn chat_snapshot(
    state: tauri::State<'_, Shared>,
    channel: String,
) -> Result<ChatBatch, ApiError> {
    let normalized = normalize_channel(&channel)?;
    let mut batch = {
        let mut hub = state.hub.lock().map_err(|_| ApiError::internal("lock"))?;
        hub.snapshot(&normalized).ok_or_else(|| ApiError {
            code: "not_found".into(),
            message: format!("нет истории для {normalized}"),
        })?
    };
    for event in &mut batch.events {
        super::irc::decorate_event(event, &state, &normalized);
    }
    Ok(batch)
}

#[tauri::command]
pub async fn chat_send(
    state: tauri::State<'_, Shared>,
    text: String,
    #[allow(non_snake_case)]
    replyToId: Option<String>,
) -> Result<(), ApiError> {
    let mut payload = format_outgoing(&text)?;
    let allow_dup = {
        let settings = state
            .settings
            .lock()
            .map_err(|_| ApiError::internal("lock"))?;
        settings
            .data
            .knobs
            .get("behaviour.allowDuplicateMessages")
            .and_then(|v| v.as_bool())
            .unwrap_or(true)
    };
    let reply_to = match replyToId.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(id) => Some(validate_msg_id(id)?),
        None => None,
    };
    let channel = {
        let hub = state.hub.lock().map_err(|_| ApiError::internal("lock"))?;
        if !hub.joined_active() {
            return Err(ApiError::invalid("канал ещё не подключён"));
        }
        hub.active
            .clone()
            .ok_or_else(|| ApiError::invalid("нет активного канала"))?
    };
    if auth::resolved_login_token(&state).is_none() {
        return Err(ApiError::invalid(
            "нужен вход Twitch, чтобы отправлять сообщения",
        ));
    }
    if allow_dup {
        let last = state
            .last_sent
            .lock()
            .map_err(|_| ApiError::internal("lock"))?;
        if last.get(&channel).map(|s| s.as_str()) == Some(payload.as_str()) {
            payload = prepare_duplicate_message(&payload);
        }
    }
    send_cmd(
        &state,
        IrcCmd::Privmsg {
            channel: channel.clone(),
            text: payload.clone(),
            reply_to,
        },
    )
    .await?;
    let mut last = state
        .last_sent
        .lock()
        .map_err(|_| ApiError::internal("lock"))?;
    last.insert(channel, payload);
    Ok(())
}

#[tauri::command]
pub fn session_get(state: tauri::State<'_, Shared>) -> Result<super::session::Session, ApiError> {
    super::session::snapshot(&state)
}

#[tauri::command]
pub async fn auth_start(
    app: AppHandle,
    state: tauri::State<'_, Shared>,
) -> Result<DeviceStart, ApiError> {
    Ok(auth::start_login(app, state.inner().clone()).await?)
}

#[tauri::command]
pub async fn auth_import(
    app: AppHandle,
    state: tauri::State<'_, Shared>,
    blob: String,
) -> Result<(), ApiError> {
    Ok(auth::import_blob(app, state.inner().clone(), blob).await?)
}

#[tauri::command]
pub fn auth_status(state: tauri::State<'_, Shared>) -> Result<AuthInfo, ApiError> {
    Ok(auth::snapshot(&state))
}

#[tauri::command]
pub async fn auth_logout(app: AppHandle, state: tauri::State<'_, Shared>) -> Result<(), ApiError> {
    Ok(auth::logout(app, state.inner().clone()).await?)
}

#[tauri::command]
pub fn chat_complete(
    state: tauri::State<'_, Shared>,
    token: String,
    first_word: bool,
) -> Result<Vec<String>, ApiError> {
    if token.chars().count() < complete::MIN_QUERY {
        return Ok(Vec::new());
    }
    if token.chars().count() > MAX_CHAT_CHARS {
        return Ok(Vec::new());
    }
    if token
        .chars()
        .any(|c| matches!(c, '\0' | '\r' | '\n' | '\u{0001}'))
    {
        return Ok(Vec::new());
    }
    if first_word && (token.starts_with('/') || token.starts_with('.')) {
        return Ok(complete::suggestions(&token, first_word, Vec::new(), Vec::new()));
    }
    let at_only = token.starts_with('@');
    let channel = {
        let hub = state.hub.lock().map_err(|_| ApiError::internal("lock"))?;
        hub.active.clone().unwrap_or_default()
    };
    let emotes = if at_only {
        Vec::new()
    } else {
        let catalog = state
            .catalog
            .lock()
            .map_err(|_| ApiError::internal("lock"))?;
        catalog.codes_prefixed(&channel, &token)
    };
    let names = {
        let chatters = state
            .chatters
            .lock()
            .map_err(|_| ApiError::internal("lock"))?;
        chatters.prefixed(&channel, &token)
    };
    Ok(complete::suggestions(
        &token, first_word, emotes, names,
    ))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub hits: Vec<super::types::SearchHit>,
}

#[tauri::command]
pub fn chat_search(
    state: tauri::State<'_, Shared>,
    channel: String,
    query: String,
) -> Result<SearchResult, ApiError> {
    let normalized = normalize_channel(&channel)?;
    if query.chars().count() > MAX_CHAT_CHARS {
        return Err(ApiError::invalid("запрос слишком длинный"));
    }
    if query
        .chars()
        .any(|c| matches!(c, '\0' | '\r' | '\n' | '\u{0001}'))
    {
        return Err(ApiError::invalid("недопустимые символы в запросе"));
    }
    let mut hub = state.hub.lock().map_err(|_| ApiError::internal("lock"))?;
    if hub.active.as_deref() != Some(normalized.as_str()) {
        return Err(ApiError::invalid("канал не активен"));
    }
    if !hub.has_channel(&normalized) {
        return Ok(SearchResult { hits: Vec::new() });
    }
    let hits = hub.buffer(&normalized).scrollback.search_hits(&query);
    Ok(SearchResult { hits })
}

#[tauri::command]
pub fn filters_get(state: tauri::State<'_, Shared>) -> Result<Filters, ApiError> {
    Ok(filters::snapshot(&state).map_err(|_| ApiError::internal("lock"))?)
}

#[tauri::command]
pub fn filters_set(
    state: tauri::State<'_, Shared>,
    filters: Filters,
) -> Result<Filters, ApiError> {
    filters::replace(&state, filters).map_err(ApiError::invalid)
}

#[tauri::command]
pub fn settings_get(
    state: tauri::State<'_, Shared>,
) -> Result<DisplaySettings, ApiError> {
    super::settings::snapshot(&state)
}

#[tauri::command]
pub fn settings_set(
    state: tauri::State<'_, Shared>,
    settings: DisplaySettings,
) -> Result<DisplaySettings, ApiError> {
    super::settings::replace(&state, settings)
}

#[tauri::command]
pub fn highlight_sound_read(
    state: tauri::State<'_, Shared>,
    path: Option<String>,
) -> Result<super::highlight_sound::SoundFile, ApiError> {
    super::highlight_sound::read_configured(&state, path)
}

#[tauri::command]
pub fn highlight_sound_pick(
    state: tauri::State<'_, Shared>,
) -> Result<String, ApiError> {
    super::highlight_sound::pick_path(&state)
}

#[tauri::command]
pub fn streamer_mode_detect() -> Result<bool, ApiError> {
    Ok(super::streamer_mode::broadcasting_software_active())
}

#[tauri::command]
pub fn open_chat_link(url: String) -> Result<(), ApiError> {
    let allowed = allowed_chat_url(&url).map_err(|message| ApiError {
        code: "invalid_input".into(),
        message,
    })?;
    tauri_plugin_opener::open_url(&allowed, None::<&str>).map_err(|e| ApiError::internal(&e.to_string()))
}

pub fn normalize_channel(raw: &str) -> Result<String, ApiError> {
    let s = raw.trim().trim_start_matches('#').to_lowercase();
    if s.is_empty() || s.len() > 25 || !s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err(ApiError {
            code: "invalid_input".into(),
            message: "имя канала: 1-25 символов [a-z0-9_]".into(),
        });
    }
    Ok(s)
}

pub fn format_outgoing(raw: &str) -> Result<String, ApiError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(ApiError::invalid("сообщение пустое"));
    }
    if trimmed.chars().count() > MAX_CHAT_CHARS {
        return Err(ApiError::invalid("сообщение длиннее 500 символов"));
    }
    if trimmed.chars().any(|c| matches!(c, '\0' | '\r' | '\n' | '\u{0001}')) {
        return Err(ApiError::invalid("сообщение содержит запрещённые символы"));
    }
    if trimmed.starts_with('/') {
        let mut parts = trimmed.splitn(2, char::is_whitespace);
        let cmd = parts.next().unwrap_or("");
        let rest = parts.next().unwrap_or("").trim();
        if cmd.eq_ignore_ascii_case("/me") {
            if rest.is_empty() {
                return Err(ApiError::invalid("пустое действие /me"));
            }
            let wire = format!("\u{0001}ACTION {rest}\u{0001}");
            if wire.chars().count() > MAX_CHAT_CHARS {
                return Err(ApiError::invalid("сообщение длиннее 500 символов"));
            }
            return Ok(wire);
        }
        let name = cmd.trim_start_matches('/');
        if !complete::is_known_command(name) {
            return Err(ApiError::invalid("неизвестная slash-команда"));
        }
    }
    Ok(trimmed.to_string())
}

/// Chatterino MAGIC_MESSAGE_SUFFIX: space + U+034F (CGJ).
const MAGIC_MESSAGE_SUFFIX: &str = " \u{034f}";

/// When the same payload is resent, Twitch may drop it; mutate like stock.
pub fn prepare_duplicate_message(message: &str) -> String {
    let bytes = message.as_bytes();
    if bytes.is_empty() {
        return format!("{message}{MAGIC_MESSAGE_SUFFIX}");
    }
    let ignore_first = matches!(bytes[0], b'/' | b'.');
    let mut space_index: Option<usize> = None;
    let mut seen = 0u8;
    for (i, &b) in bytes.iter().enumerate() {
        if b == b' ' {
            seen += 1;
            if !ignore_first || seen >= 2 {
                space_index = Some(i);
                break;
            }
        }
    }
    match space_index {
        Some(i) => {
            let mut out = String::with_capacity(message.len() + 1);
            out.push_str(&message[..i]);
            out.push_str("  ");
            out.push_str(&message[i + 1..]);
            out
        }
        None => format!("{message}{MAGIC_MESSAGE_SUFFIX}"),
    }
}

fn validate_msg_id(id: &str) -> Result<String, ApiError> {
    if id.is_empty() || id.len() > 64 {
        return Err(ApiError::invalid("некорректный id ответа"));
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(ApiError::invalid("некорректный id ответа"));
    }
    Ok(id.to_string())
}

async fn send_cmd(state: &Shared, cmd: IrcCmd) -> Result<(), ApiError> {
    let tx = state
        .irc_tx
        .lock()
        .map_err(|_| ApiError::internal("lock"))?
        .clone()
        .ok_or_else(|| ApiError::internal("irc не запущен"))?;
    tokio::time::timeout(Duration::from_secs(10), tx.send(cmd))
        .await
        .map_err(|_| ApiError::internal("таймаут очереди irc"))?
        .map_err(|_| ApiError::internal("очередь irc"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_bad_channel() {
        assert!(normalize_channel("").is_err());
        assert!(normalize_channel("has space").is_err());
        assert_eq!(normalize_channel("#XQC").unwrap(), "xqc");
    }

    #[test]
    fn open_chat_link_rejects_bad_url() {
        assert!(open_chat_link("javascript:alert(1)".into()).is_err());
        assert!(open_chat_link("https://user:pass@example.com/".into()).is_err());
        assert!(crate::chat::spans::allowed_chat_url("https://example.com/chat").is_ok());
    }

    #[test]
    fn send_rejects_empty_long_and_controls() {
        assert!(format_outgoing("").is_err());
        assert!(format_outgoing("   ").is_err());
        assert!(format_outgoing(&"a".repeat(501)).is_err());
        assert!(format_outgoing("ok\nline").is_err());
        assert!(format_outgoing("ok\rline").is_err());
        assert!(format_outgoing("ok\0x").is_err());
        assert_eq!(format_outgoing("  hello  ").unwrap(), "hello");
    }

    #[test]
    fn send_formats_me_action() {
        assert_eq!(
            format_outgoing("/me waves").unwrap(),
            "\u{0001}ACTION waves\u{0001}"
        );
        assert!(format_outgoing("/me ").is_err());
        assert!(format_outgoing("/me    ").is_err());
        assert_eq!(
            format_outgoing("/Me waves").unwrap(),
            "\u{0001}ACTION waves\u{0001}"
        );
        assert_eq!(format_outgoing("/ban bad").unwrap(), "/ban bad");
        assert!(format_outgoing("/nope").is_err());
        let long = format!("/me {}", "a".repeat(500));
        assert!(format_outgoing(&long).is_err());
    }

    #[test]
    fn duplicate_prep_magic_and_double_space() {
        assert_eq!(
            prepare_duplicate_message("hello"),
            format!("hello{MAGIC_MESSAGE_SUFFIX}")
        );
        assert_eq!(prepare_duplicate_message("hello world"), "hello  world");
        assert_eq!(
            prepare_duplicate_message("/ban target reason"),
            "/ban target  reason"
        );
        assert_eq!(
            prepare_duplicate_message("/me"),
            format!("/me{MAGIC_MESSAGE_SUFFIX}")
        );
        assert_eq!(
            prepare_duplicate_message(".timeout user 1s"),
            ".timeout user  1s"
        );
    }

    #[test]
    fn filters_set_rejects_bad_login() {
        let shared = Shared::new();
        assert!(filters::replace(
            &shared,
            Filters {
                ignore_logins: vec!["bad login".into()],
                ..Filters::default()
            }
        )
        .is_err());
    }
}

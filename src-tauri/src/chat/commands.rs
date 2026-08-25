use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager};

use super::auth::{self, AuthFail, AuthInfo, DeviceStart};
use super::complete;
use super::constants::MAX_PENDING_OUT;
use super::custom_commands::{self, CustomCommandSet, ExpandContext};
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
        if let Some(text) = hub.drop_channel(&normalized) {
            let _ = app.emit(
                "chat:send-wait",
                super::types::ChatSendWait {
                    channel_id: normalized.clone(),
                    text,
                },
            );
        }
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
    app: AppHandle,
    state: tauri::State<'_, Shared>,
    text: String,
    #[allow(non_snake_case)]
    replyToId: Option<String>,
) -> Result<(), ApiError> {
    let reply_to = match replyToId.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(id) => Some(validate_msg_id(id)?),
        None => None,
    };
    let channel = active_send_channel(&state)?;
    ensure_can_send(&state)?;
    let text = prepare_outgoing_text(&state, &channel, &text, None)?;
    dispatch_chat_send(&app, &state, &channel, text, reply_to).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomCommandInvoke {
    pub trigger: String,
    #[serde(default)]
    pub message_login: Option<String>,
    #[serde(default)]
    pub message_display: Option<String>,
    #[serde(default)]
    pub message_id: Option<String>,
    #[serde(default)]
    pub message_text: Option<String>,
    #[serde(default)]
    pub copy_text: Option<String>,
    #[serde(default)]
    pub input_text: Option<String>,
    #[allow(non_snake_case)]
    #[serde(default)]
    pub replyToId: Option<String>,
}

#[tauri::command]
pub async fn chat_exec_custom_command(
    app: AppHandle,
    state: tauri::State<'_, Shared>,
    trigger: String,
    #[allow(non_snake_case)]
    messageLogin: Option<String>,
    #[allow(non_snake_case)]
    messageDisplay: Option<String>,
    #[allow(non_snake_case)]
    messageId: Option<String>,
    #[allow(non_snake_case)]
    messageText: Option<String>,
    #[allow(non_snake_case)]
    copyText: Option<String>,
    #[allow(non_snake_case)]
    inputText: Option<String>,
    #[allow(non_snake_case)]
    replyToId: Option<String>,
) -> Result<(), ApiError> {
    let invoke = CustomCommandInvoke {
        trigger,
        message_login: messageLogin,
        message_display: messageDisplay,
        message_id: messageId,
        message_text: messageText,
        copy_text: copyText,
        input_text: inputText,
        replyToId,
    };
    let reply_to = match invoke
        .replyToId
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(id) => Some(validate_msg_id(id)?),
        None => None,
    };
    let channel = active_send_channel(&state)?;
    ensure_can_send(&state)?;
    let menu = MenuExpand {
        trigger: invoke.trigger.trim(),
        message_login: invoke.message_login.as_deref(),
        message_display: invoke.message_display.as_deref(),
        message_id: invoke.message_id.as_deref(),
        message_text: invoke.message_text.as_deref().unwrap_or(""),
        copy_text: invoke.copy_text.as_deref(),
        input_text: invoke.input_text.as_deref(),
    };
    if menu.trigger.is_empty() {
        return Err(ApiError::invalid("пустой trigger команды"));
    }
    let set = load_custom_commands(&state);
    if !set.allows_menu_trigger(menu.trigger) {
        return Err(ApiError::invalid("команда недоступна из меню сообщения"));
    }
    let text = prepare_outgoing_text(&state, &channel, "", Some(menu))?;
    dispatch_chat_send(&app, &state, &channel, text, reply_to).await
}

struct MenuExpand<'a> {
    trigger: &'a str,
    message_login: Option<&'a str>,
    message_display: Option<&'a str>,
    message_id: Option<&'a str>,
    message_text: &'a str,
    copy_text: Option<&'a str>,
    input_text: Option<&'a str>,
}

fn active_send_channel(state: &Shared) -> Result<String, ApiError> {
    let hub = state.hub.lock().map_err(|_| ApiError::internal("lock"))?;
    if !hub.joined_active() {
        return Err(ApiError::invalid("канал ещё не подключён"));
    }
    hub.active
        .clone()
        .ok_or_else(|| ApiError::invalid("нет активного канала"))
}

fn ensure_can_send(state: &Shared) -> Result<(), ApiError> {
    if auth::resolved_login_token(state).is_none() {
        return Err(ApiError::invalid(
            "нужен вход Twitch, чтобы отправлять сообщения",
        ));
    }
    Ok(())
}

fn load_custom_commands(state: &Shared) -> Arc<CustomCommandSet> {
    match state.custom_commands.lock() {
        Ok(inner) => Arc::clone(&inner),
        Err(_) => Arc::new(CustomCommandSet::default()),
    }
}

fn build_expand_context(
    state: &Shared,
    channel: &str,
    menu: Option<&MenuExpand<'_>>,
    composer_text: Option<&str>,
) -> ExpandContext {
    let hub = state.hub.lock().ok();
    let room_id = hub
        .as_ref()
        .and_then(|h| h.room_id(channel).map(str::to_string));
    let channel_live = hub.as_ref().is_some_and(|h| h.channel_live(channel));
    let stream_game = hub
        .as_ref()
        .and_then(|h| h.stream_game(channel).map(str::to_string));
    let stream_title = hub
        .as_ref()
        .and_then(|h| h.stream_title(channel).map(str::to_string));
    let my_login = auth::resolved_login_token(state).map(|(login, _)| login);
    let my_user_id = auth::resolved_twitch_user_id(state);
    if let Some(m) = menu {
        ExpandContext {
            channel: channel.to_string(),
            room_id,
            channel_live,
            my_login,
            my_user_id,
            stream_game,
            stream_title,
            message_login: m.message_login.map(str::to_string),
            message_display: m.message_display.map(str::to_string),
            message_id: m.message_id.map(str::to_string),
            message_text: Some(m.message_text.to_string()),
            input_text: m
                .input_text
                .or(composer_text)
                .map(str::to_string),
            copy_text: m.copy_text.map(str::to_string),
        }
    } else {
        ExpandContext {
            channel: channel.to_string(),
            room_id,
            channel_live,
            my_login,
            my_user_id,
            stream_game,
            stream_title,
            message_login: None,
            message_display: None,
            message_id: None,
            message_text: None,
            input_text: composer_text.map(str::to_string),
            copy_text: None,
        }
    }
}

fn prepare_outgoing_text(
    state: &Shared,
    channel: &str,
    text: &str,
    menu: Option<MenuExpand<'_>>,
) -> Result<String, ApiError> {
    let set = load_custom_commands(state);
    let expanded = match menu {
        Some(m) => {
            let ctx = build_expand_context(state, channel, Some(&m), Some(text));
            custom_commands::expand_menu_command(&set, m.trigger, m.message_text, &ctx)
                .ok_or_else(|| ApiError::invalid("команда не найдена"))?
        }
        None => {
            let ctx = build_expand_context(state, channel, None, Some(text));
            custom_commands::resolve_user_commands(&set, text, &ctx)
        }
    };
    if expanded.chars().count() > MAX_CHAT_CHARS {
        return Err(ApiError::invalid("сообщение длиннее 500 символов"));
    }
    Ok(expanded)
}

async fn dispatch_chat_send(
    app: &AppHandle,
    state: &Shared,
    channel: &str,
    text: String,
    reply_to: Option<String>,
) -> Result<(), ApiError> {
    if should_send_helix(state) {
        return send_via_helix(app, state, channel, &text, reply_to.as_deref()).await;
    }

    let mut payload = format_outgoing(&text)?;
    let allow_dup = knob_bool(state, "behaviour.allowDuplicateMessages", true);
    if allow_dup {
        let last = state
            .last_sent
            .lock()
            .map_err(|_| ApiError::internal("lock"))?;
        if last.get(channel).map(|s| s.as_str()) == Some(payload.as_str()) {
            payload = prepare_duplicate_message(&payload);
        }
    }
    if !state.try_reserve_outbound(MAX_PENDING_OUT) {
        return Err(ApiError::invalid(
            "очередь отправки полна, подождите подключения",
        ));
    }
    if let Err(err) = send_cmd(
        state,
        IrcCmd::Privmsg {
            channel: channel.to_string(),
            text: payload,
            reply_to,
        },
    )
    .await
    {
        state.release_outbound(1);
        return Err(err);
    }
    super::provider_activity::post_send_activity(state.clone(), channel.to_string());
    Ok(())
}

fn custom_command_triggers(state: &Shared) -> Vec<String> {
    load_custom_commands(state).triggers().to_vec()
}

async fn send_via_helix(
    app: &AppHandle,
    state: &Shared,
    channel: &str,
    text: &str,
    reply_to: Option<&str>,
) -> Result<(), ApiError> {
    if is_unknown_command_for_helix(text.trim()) {
        let cmd = text.trim().split_whitespace().next().unwrap_or("");
        state.post_channel_notice(
            app,
            channel,
            format!("{cmd} is not a known command."),
        );
        return Ok(());
    }
    let mut payload = format_outgoing_helix(text)?;
    let high_rate = state
        .hub
        .lock()
        .ok()
        .is_some_and(|h| h.channel_self_high_rate(channel));
    let allow_dup = knob_bool(state, "behaviour.allowDuplicateMessages", true);
    if allow_dup && !high_rate {
        let last = state
            .last_sent
            .lock()
            .map_err(|_| ApiError::internal("lock"))?;
        if last.get(channel).map(|s| s.as_str()) == Some(payload.as_str()) {
            payload = prepare_duplicate_message(&payload);
        }
    }
    match state
        .send_rate
        .lock()
        .map_err(|_| ApiError::internal("lock"))?
        .prepare(high_rate)
    {
        super::send_wait::PrepareSend::Ok => {}
        super::send_wait::PrepareSend::Notice(msg) => {
            state.post_channel_notice(app, channel, msg.into());
            return Ok(());
        }
        super::send_wait::PrepareSend::Blocked => return Ok(()),
    }
    let room_id = state
        .hub
        .lock()
        .ok()
        .and_then(|h| h.room_id(channel).map(str::to_string))
        .or_else(|| {
            state
                .snapshot_bttv_wanted()
                .channel
                .filter(|c| c.login == channel)
                .map(|c| c.room_id)
        });
    let Some(room_id) = room_id else {
        state.post_channel_notice(
            app,
            channel,
            "Sending messages in this channel isn't possible.".into(),
        );
        return Ok(());
    };
    let sender_id = auth::ensure_twitch_user_id(state).await;
    let Some(sender_id) = sender_id else {
        state.post_channel_notice(
            app,
            channel,
            "Sending messages in this channel isn't possible.".into(),
        );
        return Ok(());
    };
    let token = auth::oauth_token(state).ok_or_else(|| {
        ApiError::invalid("нужен вход Twitch, чтобы отправлять сообщения")
    })?;
    let client_id = auth::resolved_client_id(state);
    if let Ok(mut last) = state.last_sent.lock() {
        last.insert(channel.to_string(), payload.clone());
    }
    super::provider_activity::post_send_activity(state.clone(), channel.to_string());
    let outcome = super::helix::send_chat_message(
        &room_id,
        &sender_id,
        &payload,
        reply_to,
        &token,
        &client_id,
    )
    .await;
    match outcome {
        super::helix::HelixSendOutcome::Sent => Ok(()),
        super::helix::HelixSendOutcome::Dropped(msg) | super::helix::HelixSendOutcome::Failed(msg) => {
            state.post_channel_notice(app, channel, msg);
            Ok(())
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ChatSendProtocol {
    Default,
    Irc,
    Helix,
}

fn chat_send_protocol(shared: &Shared) -> ChatSendProtocol {
    let raw = shared
        .settings
        .lock()
        .ok()
        .and_then(|inner| {
            inner
                .data
                .knobs
                .get("misc.chatSendProtocol")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| "Default".into());
    match raw.as_str() {
        "Helix" => ChatSendProtocol::Helix,
        "IRC" => ChatSendProtocol::Irc,
        _ => ChatSendProtocol::Default,
    }
}

fn should_send_helix(shared: &Shared) -> bool {
    matches!(chat_send_protocol(shared), ChatSendProtocol::Helix)
}

fn knob_bool(shared: &Shared, key: &str, default: bool) -> bool {
    shared
        .settings
        .lock()
        .ok()
        .and_then(|inner| inner.data.knobs.get(key).and_then(Value::as_bool))
        .unwrap_or(default)
}

// Chatterino TwitchChannel.cpp isUnknownCommand (Helix path only).
pub fn is_unknown_command_for_helix(text: &str) -> bool {
    let t = text.trim();
    if t.is_empty() {
        return false;
    }
    let first = match t.chars().next() {
        Some(c) => c,
        None => return false,
    };
    let after_first = &t[first.len_utf8()..];
    match first {
        '/' => {}
        '.' => {
            if after_first.is_empty() {
                return false;
            }
            if after_first.starts_with('.') {
                return false;
            }
        }
        _ => return false,
    }
    if after_first.starts_with(char::is_whitespace) {
        return false;
    }
    let lower: String = after_first.chars().flat_map(|c| c.to_lowercase()).collect();
    if lower == "me" || lower.starts_with("me ") {
        return false;
    }
    true
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
    let colon = complete::colon_emote_needle(&token).is_some();
    if token.chars().count() < complete::MIN_QUERY && !(colon && token == ":") {
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
        return Ok(complete::suggestions_with_custom(
            &token,
            first_word,
            Vec::new(),
            Vec::new(),
            &custom_command_triggers(state.inner()),
        ));
    }
    let (smart, prefix_only, user_completion_only_with_at, always_include_broadcaster) = {
        let settings = state
            .settings
            .lock()
            .map_err(|_| ApiError::internal("lock"))?;
        let knobs = &settings.data.knobs;
        (
            knobs
                .get("experiments.useSmartEmoteCompletion")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            knobs
                .get("behaviour.prefixOnlyEmoteCompletion")
                .and_then(|v| v.as_bool())
                .unwrap_or(true),
            knobs
                .get("behaviour.userCompletionOnlyWithAt")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            knobs
                .get("behaviour.alwaysIncludeBroadcasterInUserCompletions")
                .and_then(|v| v.as_bool())
                .unwrap_or(true),
        )
    };
    let emote_mode = if prefix_only {
        super::emotes::MatchMode::Prefix
    } else {
        super::emotes::MatchMode::Contains
    };
    let channel = {
        let hub = state.hub.lock().map_err(|_| ApiError::internal("lock"))?;
        hub.active.clone().unwrap_or_default()
    };
    // `:query` → emote-only (stock TabCompletionModel SourceKind::Emote).
    if let Some(needle) = complete::colon_emote_needle(&token) {
        let catalog = state
            .catalog
            .lock()
            .map_err(|_| ApiError::internal("lock"))?;
        let emotes = if smart {
            let (zw_only, query) = if let Some(rest) = needle.strip_prefix('~') {
                (true, rest)
            } else {
                (false, needle)
            };
            let pool = catalog.codes_matching(
                &channel,
                "",
                super::emotes::MatchMode::Contains,
                false,
                zw_only,
            );
            let mut ranked = complete::apply_smart_emotes(query, pool, true, true, zw_only);
            ranked.truncate(complete::COMPLETE_LIMIT);
            ranked
        } else {
            let mut emotes = catalog.codes_matching(
                &channel,
                needle,
                super::emotes::MatchMode::Contains,
                false,
                false,
            );
            if needle.is_empty() {
                emotes.truncate(complete::COMPLETE_LIMIT);
            }
            emotes
        };
        return Ok(complete::suggestions_with_rank(
            &token,
            first_word,
            emotes,
            Vec::new(),
            !smart,
        ));
    }
    let at_only = token.starts_with('@');
    let emotes = if at_only {
        Vec::new()
    } else if smart {
        let catalog = state
            .catalog
            .lock()
            .map_err(|_| ApiError::internal("lock"))?;
        let pool = catalog.codes_matching(&channel, "", emote_mode, false, false);
        let mut ranked =
            complete::apply_smart_emotes(&token, pool, !prefix_only, false, false);
        ranked.truncate(complete::COMPLETE_LIMIT);
        ranked
    } else {
        let catalog = state
            .catalog
            .lock()
            .map_err(|_| ApiError::internal("lock"))?;
        catalog.codes_matching(&channel, &token, emote_mode, false, false)
    };
    let names = if user_completion_only_with_at && !at_only {
        Vec::new()
    } else {
        let chatters = state
            .chatters
            .lock()
            .map_err(|_| ApiError::internal("lock"))?;
        chatters.prefixed(&channel, &token, always_include_broadcaster)
    };
    Ok(complete::suggestions_with_rank(
        &token,
        first_word,
        emotes,
        names,
        !smart || at_only,
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
pub fn logging_pick_directory(
    state: tauri::State<'_, Shared>,
) -> Result<String, ApiError> {
    super::logging::pick_directory(&state)
}

#[tauri::command]
pub fn highlight_request_attention(
    app: tauri::AppHandle,
    long_alerts: bool,
) -> Result<(), ApiError> {
    use tauri::UserAttentionType;
    let Some(window) = app.get_webview_window("main") else {
        return Err(ApiError::internal("окно main недоступно"));
    };
    let kind = if long_alerts {
        UserAttentionType::Critical
    } else {
        UserAttentionType::Informational
    };
    window
        .request_user_attention(Some(kind))
        .map_err(|e| ApiError::internal(&e.to_string()))
}

#[tauri::command]
pub fn highlight_cancel_attention(app: tauri::AppHandle) -> Result<(), ApiError> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };
    let _ = window.request_user_attention(None);
    Ok(())
}

#[tauri::command]
pub fn streamer_mode_detect() -> Result<bool, ApiError> {
    Ok(super::streamer_mode::broadcasting_software_active())
}

#[tauri::command]
pub async fn chat_user_profile(
    state: tauri::State<'_, Shared>,
    login: String,
) -> Result<super::helix::UserProfile, ApiError> {
    let normalized = normalize_channel(&login)?;
    let token = auth::oauth_token(&state);
    let client_id = auth::resolved_client_id(&state);
    if token.is_none() {
        return Err(ApiError {
            code: "auth_required".into(),
            message: "нужен вход Twitch для профиля".into(),
        });
    }
    super::helix::fetch_user_profile(&normalized, token.as_deref(), &client_id)
        .await
        .ok_or_else(|| ApiError {
            code: "not_found".into(),
            message: "пользователь не найден".into(),
        })
}

#[tauri::command]
pub fn supports_incognito_links() -> bool {
    super::incognito::supports_incognito()
}

#[tauri::command]
pub fn open_chat_link(url: String, private: Option<bool>) -> Result<(), ApiError> {
    let allowed = allowed_chat_url(&url).map_err(|message| ApiError {
        code: "invalid_input".into(),
        message,
    })?;
    if private.unwrap_or(false) && super::incognito::supports_incognito() {
        if super::incognito::open_incognito(&allowed).is_ok() {
            return Ok(());
        }
        // Spawn failed: fall through to normal opener (stock still opens).
    }
    tauri_plugin_opener::open_url(&allowed, None::<&str>)
        .map_err(|e| ApiError::internal(&e.to_string()))
}

#[tauri::command]
pub fn open_in_streamlink(
    state: tauri::State<'_, Shared>,
    channel: String,
) -> Result<(), ApiError> {
    super::streamlink::open_for_channel(state.inner(), &channel).map_err(|message| {
        let code = if message.contains("channel name")
            || message.contains("custom path")
            || message.contains("options")
            || message.contains("Unable to find")
        {
            "invalid_input"
        } else {
            "internal"
        };
        ApiError {
            code: code.into(),
            message,
        }
    })
}

#[tauri::command]
pub fn open_in_custom_player(
    state: tauri::State<'_, Shared>,
    channel: String,
) -> Result<(), ApiError> {
    super::custom_player::open_for_channel(state.inner(), &channel).map_err(|message| {
        let code = if message.contains("channel name")
            || message.contains("URI scheme")
            || message.contains("forbidden")
        {
            "invalid_input"
        } else {
            "internal"
        };
        ApiError {
            code: code.into(),
            message,
        }
    })
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

pub fn format_outgoing_helix(raw: &str) -> Result<String, ApiError> {
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
        if cmd.eq_ignore_ascii_case("/me") && rest.is_empty() {
            return Err(ApiError::invalid("пустое действие /me"));
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
        assert!(open_chat_link("javascript:alert(1)".into(), None).is_err());
        assert!(open_chat_link("https://user:pass@example.com/".into(), None).is_err());
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
    fn chat_send_protocol_modes() {
        let shared = Shared::new();
        assert!(!should_send_helix(&shared));
        {
            let mut settings = shared.settings.lock().unwrap();
            settings
                .data
                .knobs
                .insert("misc.chatSendProtocol".into(), Value::String("Helix".into()));
        }
        assert!(should_send_helix(&shared));
        {
            let mut settings = shared.settings.lock().unwrap();
            settings
                .data
                .knobs
                .insert("misc.chatSendProtocol".into(), Value::String("IRC".into()));
        }
        assert!(!should_send_helix(&shared));
    }

    #[test]
    fn is_unknown_command_for_helix_matches_stock() {
        for input in [
            "/me hello",
            ".me hello",
            "/ hello",
            ". hello",
            "/ /hello",
            ". .hello",
            ".",
            "/me",
            ".me",
            "..",
            "...",
            "hello",
            "/ me",
        ] {
            assert!(
                !is_unknown_command_for_helix(input),
                "{input} should not be unknown"
            );
        }
        for input in [
            "/badcommand",
            ".badcommand",
            "/ban user",
            ".timeout user 1",
            "//",
            "./",
            "/.",
        ] {
            assert!(
                is_unknown_command_for_helix(input),
                "{input} should be unknown"
            );
        }
    }

    #[test]
    fn format_outgoing_helix_keeps_me_as_text() {
        assert_eq!(format_outgoing_helix("/me waves").unwrap(), "/me waves");
        assert_eq!(format_outgoing_helix("  hello  ").unwrap(), "hello");
        assert!(format_outgoing_helix("/me ").is_err());
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

    #[test]
    fn prepare_outgoing_expands_custom_trigger() {
        use super::super::settings::{AppSettings, CommandRow};
        let shared = Shared::new();
        super::super::settings::rebuild_custom_commands(
            &shared,
            &AppSettings {
                commands: vec![CommandRow {
                    trigger: "/hello".into(),
                    command: "hi {1}".into(),
                    show_in_message_menu: false,
                }],
                ..AppSettings::default()
            },
        );
        let text = prepare_outgoing_text(&shared, "xqc", "/hello world", None).unwrap();
        assert_eq!(text, "hi world");
    }
}

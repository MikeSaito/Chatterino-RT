use std::time::Duration;

use serde::Serialize;
use tauri::AppHandle;

use super::auth::{self, AuthFail, AuthInfo, DeviceStart};
use super::spans::allowed_chat_url;
use super::state::{IrcCmd, Shared};
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

    fn invalid(message: impl Into<String>) -> Self {
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
) -> Result<String, ApiError> {
    let normalized = normalize_channel(&channel)?;
    send_cmd(&state, IrcCmd::Join(normalized.clone())).await?;
    {
        let mut hub = state.hub.lock().map_err(|_| ApiError::internal("lock"))?;
        hub.set_active(Some(normalized.clone()));
        hub.buffer(&normalized);
    }
    if let Ok(mut cat) = state.catalog.lock() {
        cat.retain_channel(&normalized);
    }
    if let Ok(mut cat) = state.badges.lock() {
        cat.retain_channel(&normalized);
    }
    if let Ok(mut cat) = state.cheers.lock() {
        cat.retain_channel(&normalized);
    }
    auth::emit(&app, &state);
    Ok(normalized)
}

#[tauri::command]
pub async fn chat_part(app: AppHandle, state: tauri::State<'_, Shared>) -> Result<(), ApiError> {
    send_cmd(&state, IrcCmd::Part).await?;
    {
        let mut hub = state.hub.lock().map_err(|_| ApiError::internal("lock"))?;
        hub.set_active(None);
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
    auth::emit(&app, &state);
    Ok(())
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
pub async fn chat_send(state: tauri::State<'_, Shared>, text: String) -> Result<(), ApiError> {
    let payload = format_outgoing(&text)?;
    let channel = {
        let hub = state.hub.lock().map_err(|_| ApiError::internal("lock"))?;
        if !hub.joined {
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
    send_cmd(
        &state,
        IrcCmd::Privmsg {
            channel,
            text: payload,
        },
    )
    .await
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
    if trimmed == "/me" {
        return Err(ApiError::invalid("пустое действие /me"));
    }
    if let Some(rest) = trimmed.strip_prefix("/me ") {
        let action = rest.trim();
        if action.is_empty() {
            return Err(ApiError::invalid("пустое действие /me"));
        }
        let wire = format!("\u{0001}ACTION {action}\u{0001}");
        if wire.chars().count() > MAX_CHAT_CHARS {
            return Err(ApiError::invalid("сообщение длиннее 500 символов"));
        }
        return Ok(wire);
    }
    Ok(trimmed.to_string())
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
        assert_eq!(format_outgoing("/Me waves").unwrap(), "/Me waves");
        let long = format!("/me {}", "a".repeat(500));
        assert!(format_outgoing(&long).is_err());
    }
}

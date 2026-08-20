use std::time::Duration;

use serde::Serialize;

use super::irc::IrcCmd;
use super::spans::allowed_chat_url;
use super::state::Shared;
use super::types::ChatBatch;

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
}

#[tauri::command]
pub async fn chat_join(
    state: tauri::State<'_, Shared>,
    channel: String,
) -> Result<String, ApiError> {
    let normalized = normalize_channel(&channel)?;
    let tx = state
        .irc_tx
        .lock()
        .map_err(|_| ApiError::internal("lock"))?
        .clone()
        .ok_or_else(|| ApiError::internal("irc не запущен"))?;
    tokio::time::timeout(Duration::from_secs(10), tx.send(IrcCmd::Join(normalized.clone())))
        .await
        .map_err(|_| ApiError::internal("таймаут очереди irc"))?
        .map_err(|_| ApiError::internal("очередь irc"))?;
    {
        let mut hub = state.hub.lock().map_err(|_| ApiError::internal("lock"))?;
        hub.set_active(Some(normalized.clone()));
        hub.buffer(&normalized);
    }
    if let Ok(mut cat) = state.catalog.lock() {
        cat.retain_channel(&normalized);
    }
    Ok(normalized)
}

#[tauri::command]
pub async fn chat_part(state: tauri::State<'_, Shared>) -> Result<(), ApiError> {
    let tx = state
        .irc_tx
        .lock()
        .map_err(|_| ApiError::internal("lock"))?
        .clone()
        .ok_or_else(|| ApiError::internal("irc не запущен"))?;
    tokio::time::timeout(Duration::from_secs(10), tx.send(IrcCmd::Part))
        .await
        .map_err(|_| ApiError::internal("таймаут очереди irc"))?
        .map_err(|_| ApiError::internal("очередь irc"))?;
    {
        let mut hub = state.hub.lock().map_err(|_| ApiError::internal("lock"))?;
        hub.set_active(None);
    }
    if let Ok(mut cat) = state.catalog.lock() {
        cat.clear_channels();
    }
    Ok(())
}

#[tauri::command]
pub fn chat_snapshot(
    state: tauri::State<'_, Shared>,
    channel: String,
) -> Result<ChatBatch, ApiError> {
    let normalized = normalize_channel(&channel)?;
    let mut hub = state.hub.lock().map_err(|_| ApiError::internal("lock"))?;
    hub.snapshot(&normalized).ok_or_else(|| ApiError {
        code: "not_found".into(),
        message: format!("нет истории для {normalized}"),
    })
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
}

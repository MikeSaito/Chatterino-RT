use std::collections::BTreeMap;
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

#[derive(Debug, Clone, Serialize)]
pub struct ApiError {
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub params: BTreeMap<String, String>,
}

impl ApiError {
    pub fn coded(code: impl Into<String>, message_en: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message_en.into(),
            params: BTreeMap::new(),
        }
    }

    pub fn coded_params(
        code: impl Into<String>,
        message_en: impl Into<String>,
        params: BTreeMap<String, String>,
    ) -> Self {
        Self {
            code: code.into(),
            message: message_en.into(),
            params,
        }
    }

    pub fn internal(msg: &str) -> Self {
        Self {
            code: "internal".into(),
            message: msg.into(),
            params: BTreeMap::new(),
        }
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        // Prefer coded() for user-facing; keep for transitional EN-only diagnostics
        Self {
            code: "invalid_input".into(),
            message: message.into(),
            params: BTreeMap::new(),
        }
    }
}

impl From<AuthFail> for ApiError {
    fn from(e: AuthFail) -> Self {
        Self {
            code: e.code,
            message: e.message,
            params: e.params,
        }
    }
}

impl From<super::poll_actions::PollActionsError> for ApiError {
    fn from(e: super::poll_actions::PollActionsError) -> Self {
        Self {
            code: e.code,
            message: e.message,
            params: e.params,
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
    if do_focus {
        super::session::emit_roomstate(&app, &state, &normalized);
        state.notify_polls(super::polls::PollsCmd::SetChannel(normalized.clone()));
        state.notify_low_trust(super::low_trust::LowTrustCmd::SetChannel(normalized.clone()));
        state.notify_pins(super::pins::PinsCmd::SetChannel(normalized.clone()));
        state.notify_shared_bans(super::shared_bans::SharedBansCmd::SetChannel(
            normalized.clone(),
        ));
    }
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
        state.notify_polls(super::polls::PollsCmd::ClearChannel);
        state.notify_low_trust(super::low_trust::LowTrustCmd::ClearChannel);
        state.notify_pins(super::pins::PinsCmd::ClearChannel);
        state.notify_shared_bans(super::shared_bans::SharedBansCmd::ClearChannel);
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
        state.hub.lock().ok().and_then(|h| h.active.clone())
    };
    if left_was_active {
        if let Some(ch) = next.as_ref() {
            {
                let mut hub = state.hub.lock().map_err(|_| ApiError::internal("lock"))?;
                hub.set_active(Some(ch.clone()));
            }
            let _ = super::session::remember(&state, ch.clone(), true);
            send_cmd(&state, IrcCmd::Join(ch.clone())).await?;
            super::session::emit_roomstate(&app, &state, ch);
            state.notify_polls(super::polls::PollsCmd::SetChannel(ch.clone()));
            state.notify_low_trust(super::low_trust::LowTrustCmd::SetChannel(ch.clone()));
            state.notify_pins(super::pins::PinsCmd::SetChannel(ch.clone()));
            state.notify_shared_bans(super::shared_bans::SharedBansCmd::SetChannel(ch.clone()));
        } else {
            let _ = super::session::clear_last(&state);
            state.notify_polls(super::polls::PollsCmd::ClearChannel);
            state.notify_low_trust(super::low_trust::LowTrustCmd::ClearChannel);
            state.notify_pins(super::pins::PinsCmd::ClearChannel);
            state.notify_shared_bans(super::shared_bans::SharedBansCmd::ClearChannel);
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
    state.notify_polls(super::polls::PollsCmd::ClearChannel);
    state.notify_low_trust(super::low_trust::LowTrustCmd::ClearChannel);
    state.notify_pins(super::pins::PinsCmd::ClearChannel);
    state.notify_shared_bans(super::shared_bans::SharedBansCmd::ClearChannel);
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
) -> Result<u64, ApiError> {
    state
        .set_batch_channel(channel)
        .map_err(|_| ApiError::internal("lock"))
}

#[tauri::command]
pub fn chat_unsubscribe(
    state: tauri::State<'_, Shared>,
    generation: Option<u64>,
) -> Result<(), ApiError> {
    state
        .clear_batch_channel(generation)
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
        hub.snapshot(&normalized).ok_or_else(|| {
            ApiError::coded_params(
                "error.channel.no_history",
                format!("no history for {normalized}"),
                BTreeMap::from([("channel".into(), normalized.clone())]),
            )
        })?
    };
    for event in &mut batch.events {
        super::irc::decorate_event(event, &state, &normalized);
    }
    Ok(batch)
}

/// Send chat text. Optional `channel` binds the send to a joined snapshot
/// (mod gutter / UserCard / timeout popup) so a tab switch mid-flight cannot
/// retarget hub.active. Composer omits `channel`.
#[tauri::command]
pub async fn chat_send(
    app: AppHandle,
    state: tauri::State<'_, Shared>,
    text: String,
    #[allow(non_snake_case)] replyToId: Option<String>,
    channel: Option<String>,
) -> Result<(), ApiError> {
    let reply_to = match replyToId
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(id) => Some(validate_msg_id(id)?),
        None => None,
    };
    let channel = resolve_send_channel(&state, channel.as_deref())?;
    ensure_can_send(&state)?;
    let text = prepare_outgoing_text(&state, &channel, &text, None)?;
    dispatch_chat_send(&app, &state, &channel, text, reply_to).await
}

#[tauri::command]
pub async fn chat_typing(state: tauri::State<'_, Shared>, active: bool) -> Result<(), ApiError> {
    let channel = active_send_channel(&state)?;
    ensure_can_send(&state)?;
    let allowed = {
        let hub = state.hub.lock().map_err(|_| ApiError::internal("lock"))?;
        let role = hub.viewer_role(&channel, auth::resolved_twitch_user_id(&state).as_deref());
        role.is_mod || role.is_broadcaster
    };
    if !allowed {
        return Ok(());
    }
    send_cmd(&state, IrcCmd::Typing { channel, active }).await
}

#[tauri::command]
pub async fn chat_automod_manage(
    app: AppHandle,
    state: tauri::State<'_, Shared>,
    #[allow(non_snake_case)] msgId: String,
    action: String,
    channel: String,
) -> Result<(), ApiError> {
    super::automod::manage_message(app, state.inner().clone(), msgId, action, channel).await
}

#[tauri::command]
pub async fn chat_pin_message(
    state: tauri::State<'_, Shared>,
    channel: String,
    #[allow(non_snake_case)] messageId: String,
    #[allow(non_snake_case)] durationSeconds: Option<u32>,
) -> Result<(), ApiError> {
    super::pins::pin_message(state.inner(), &channel, &messageId, durationSeconds).await
}

#[tauri::command]
pub async fn chat_unpin_message(
    state: tauri::State<'_, Shared>,
    channel: String,
    #[allow(non_snake_case)] messageId: String,
) -> Result<(), ApiError> {
    super::pins::unpin_message(state.inner(), &channel, &messageId).await
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
    #[serde(default, rename = "replyToId")]
    pub reply_to_id: Option<String>,
}

#[tauri::command]
pub async fn chat_exec_custom_command(
    app: AppHandle,
    state: tauri::State<'_, Shared>,
    trigger: String,
    #[allow(non_snake_case)] messageLogin: Option<String>,
    #[allow(non_snake_case)] messageDisplay: Option<String>,
    #[allow(non_snake_case)] messageId: Option<String>,
    #[allow(non_snake_case)] messageText: Option<String>,
    #[allow(non_snake_case)] copyText: Option<String>,
    #[allow(non_snake_case)] inputText: Option<String>,
    #[allow(non_snake_case)] replyToId: Option<String>,
) -> Result<(), ApiError> {
    let invoke = CustomCommandInvoke {
        trigger,
        message_login: messageLogin,
        message_display: messageDisplay,
        message_id: messageId,
        message_text: messageText,
        copy_text: copyText,
        input_text: inputText,
        reply_to_id: replyToId,
    };
    let reply_to = match invoke
        .reply_to_id
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
        return Err(ApiError::coded(
            "error.command.empty_trigger",
            "empty command trigger",
        ));
    }
    let set = load_custom_commands(&state);
    if !set.allows_menu_trigger(menu.trigger) {
        return Err(ApiError::coded(
            "error.command.menu_unavailable",
            "command is not available from the message menu",
        ));
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
        return Err(ApiError::coded(
            "error.channel.not_joined",
            "channel is not connected yet",
        ));
    }
    hub.active
        .clone()
        .ok_or_else(|| ApiError::coded("error.channel.none_active", "no active channel"))
}

/// Resolve outbound channel: explicit joined snapshot, or current hub.active.
fn resolve_send_channel(state: &Shared, requested: Option<&str>) -> Result<String, ApiError> {
    let Some(raw) = requested.map(str::trim).filter(|s| !s.is_empty()) else {
        return active_send_channel(state);
    };
    let normalized = normalize_channel(raw)?;
    let hub = state.hub.lock().map_err(|_| ApiError::internal("lock"))?;
    if !hub.is_joined(&normalized) {
        return Err(ApiError::coded(
            "error.channel.not_joined",
            "channel is not connected yet",
        ));
    }
    if !hub.has_channel(&normalized) {
        return Err(ApiError::coded(
            "error.channel.inactive",
            "channel is not active",
        ));
    }
    Ok(normalized)
}

fn warn_fail_api_error(msg: String) -> ApiError {
    let lower = msg.to_ascii_lowercase();
    if lower.contains("missing required scope") {
        return ApiError::coded("error.warn.scope", msg);
    }
    // Keep Helix detail in `message`; avoid a catalog `error.*` key that would
    // replace it with a generic string in formatInvokeError.
    ApiError {
        code: "warn.failed".into(),
        message: msg,
        params: BTreeMap::new(),
    }
}

fn ensure_can_send(state: &Shared) -> Result<(), ApiError> {
    if auth::resolved_login_token(state).is_none() {
        return Err(ApiError::coded(
            "error.auth.required_send",
            "Twitch login required to send messages",
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
            input_text: m.input_text.or(composer_text).map(str::to_string),
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
                .ok_or_else(|| ApiError::coded("error.command.not_found", "command not found"))?
        }
        None => {
            let ctx = build_expand_context(state, channel, None, Some(text));
            custom_commands::resolve_user_commands(&set, text, &ctx)
        }
    };
    let max_chars = if looks_like_warn_slash(&expanded) {
        // Helix reason max 500; command prefix + optional --channel args need headroom.
        WARN_SLASH_MAX_CHARS
    } else {
        MAX_CHAT_CHARS
    };
    if expanded.chars().count() > max_chars {
        return Err(ApiError::coded_params(
            "error.message.too_long",
            format!("message longer than {max_chars} characters"),
            BTreeMap::from([("max".into(), max_chars.to_string())]),
        ));
    }
    Ok(expanded)
}

fn looks_like_warn_slash(text: &str) -> bool {
    let t = text.trim();
    let Some(first) = t.chars().next() else {
        return false;
    };
    if first != '/' && first != '.' {
        return false;
    }
    let rest = t[first.len_utf8()..].trim_start();
    let cmd = rest
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    cmd == "warn"
}

async fn dispatch_chat_send(
    app: &AppHandle,
    state: &Shared,
    channel: &str,
    text: String,
    reply_to: Option<String>,
) -> Result<(), ApiError> {
    if let Some(raid) = parse_raid_slash(text.trim()) {
        return handle_raid_slash(app, state, channel, raid).await;
    }
    if let Some(warn) = parse_warn_slash(text.trim()) {
        return handle_warn_slash(app, state, channel, warn).await;
    }
    if let Some(lt) = super::low_trust::parse_low_trust_slash(text.trim()) {
        return super::low_trust::handle_low_trust_slash(app, state, channel, lt).await;
    }
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
        return Err(ApiError::coded(
            "error.message.send_queue_full",
            "send queue is full, wait for connection",
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

const OUTGOING_RAID_DURATION_MS: u64 = 90_000;

#[derive(Debug, Clone, PartialEq, Eq)]
enum RaidSlash {
    Start { target: String },
    Cancel,
    UsageStart,
    UsageCancel,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OutgoingRaidPayload {
    channel: String,
    active: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    target_login: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    target_display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    started_at_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    duration_ms: Option<u64>,
}

fn parse_raid_slash(text: &str) -> Option<RaidSlash> {
    let t = text.trim();
    if t.is_empty() {
        return None;
    }
    let first = t.chars().next()?;
    if first != '/' && first != '.' {
        return None;
    }
    let rest = t[first.len_utf8()..].trim_start();
    if rest.is_empty() {
        return None;
    }
    let mut parts = rest.split_whitespace();
    let cmd = parts.next()?.to_ascii_lowercase();
    match cmd.as_str() {
        "raid" => {
            let Some(raw_target) = parts.next() else {
                return Some(RaidSlash::UsageStart);
            };
            if parts.next().is_some() {
                return Some(RaidSlash::UsageStart);
            }
            let target = raw_target.trim().trim_start_matches(['#', '@']);
            if target.is_empty()
                || target.len() > 25
                || !target
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_')
            {
                return Some(RaidSlash::UsageStart);
            }
            Some(RaidSlash::Start {
                target: target.to_ascii_lowercase(),
            })
        }
        "unraid" => {
            if parts.next().is_some() {
                return Some(RaidSlash::UsageCancel);
            }
            Some(RaidSlash::Cancel)
        }
        _ => None,
    }
}

/// Twitch Helix warn reason max length (API reference).
const WARN_REASON_MAX_CHARS: usize = 500;
/// `/warn` + login + spaces + optional `--channel` args + reason headroom.
const WARN_SLASH_MAX_CHARS: usize = 200 + WARN_REASON_MAX_CHARS;

const WARN_USAGE: &str = r#"Usage: "/warn [options...] <username> <reason>" - Warn a user via their username. Reason is required and will be shown to the target user and other moderators. Options: --channel <channel> to override which channel the warn takes place in (can be specified multiple times)."#;

#[derive(Debug, Clone, PartialEq, Eq)]
struct WarnTargetRef {
    login: Option<String>,
    id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum WarnSlash {
    Usage,
    MissingReason,
    ReasonTooLong,
    Action {
        target: WarnTargetRef,
        reason: String,
        /// Empty = current chat channel.
        channels: Vec<WarnTargetRef>,
    },
}

fn parse_user_name_or_id(raw: &str) -> Option<WarnTargetRef> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(id) = trimmed.strip_prefix("id:") {
        let id = id.trim();
        if id.is_empty() || !id.chars().all(|c| c.is_ascii_digit()) {
            return None;
        }
        return Some(WarnTargetRef {
            login: None,
            id: Some(id.to_string()),
        });
    }
    let mut login = trimmed.trim_start_matches(['#', '@']);
    if let Some(stripped) = login.strip_suffix(',') {
        login = stripped;
    }
    if login.is_empty()
        || login.len() > 25
        || !login.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
    {
        return None;
    }
    Some(WarnTargetRef {
        login: Some(login.to_ascii_lowercase()),
        id: None,
    })
}

fn parse_warn_slash(text: &str) -> Option<WarnSlash> {
    let t = text.trim();
    if t.is_empty() {
        return None;
    }
    let first = t.chars().next()?;
    if first != '/' && first != '.' {
        return None;
    }
    let rest = t[first.len_utf8()..].trim_start();
    if rest.is_empty() {
        return None;
    }
    let mut parts = rest.split_whitespace();
    let cmd = parts.next()?.to_ascii_lowercase();
    if cmd != "warn" {
        return None;
    }

    let mut channels: Vec<WarnTargetRef> = Vec::new();
    let mut positional: Vec<String> = Vec::new();
    while let Some(tok) = parts.next() {
        if tok.eq_ignore_ascii_case("--channel") {
            let Some(ch) = parts.next() else {
                return Some(WarnSlash::Usage);
            };
            let Some(parsed) = parse_user_name_or_id(ch) else {
                return Some(WarnSlash::Usage);
            };
            channels.push(parsed);
            continue;
        }
        if tok.starts_with("--") {
            return Some(WarnSlash::Usage);
        }
        positional.push(tok.to_string());
        for more in parts.by_ref() {
            positional.push(more.to_string());
        }
        break;
    }

    if positional.is_empty() {
        return Some(WarnSlash::Usage);
    }
    let Some(target) = parse_user_name_or_id(&positional[0]) else {
        return Some(WarnSlash::Usage);
    };
    let reason = positional[1..].join(" ");
    if reason.trim().is_empty() {
        return Some(WarnSlash::MissingReason);
    }
    if reason.chars().any(|c| matches!(c, '\0' | '\r' | '\n')) {
        return Some(WarnSlash::Usage);
    }
    if reason.chars().count() > WARN_REASON_MAX_CHARS {
        return Some(WarnSlash::ReasonTooLong);
    }
    Some(WarnSlash::Action {
        target,
        reason,
        channels,
    })
}

async fn resolve_warn_profile(
    target: &WarnTargetRef,
    token: &str,
    client_id: &str,
) -> Option<super::helix::UserProfile> {
    if let Some(id) = target.id.as_deref() {
        return super::helix::fetch_user_profile_by_id(id, Some(token), client_id).await;
    }
    let login = target.login.as_deref()?;
    super::helix::fetch_user_profile(login, Some(token), client_id).await
}

async fn handle_warn_slash(
    app: &AppHandle,
    state: &Shared,
    channel: &str,
    cmd: WarnSlash,
) -> Result<(), ApiError> {
    match &cmd {
        WarnSlash::Usage => {
            state.post_channel_notice(app, channel, WARN_USAGE.into());
            return Ok(());
        }
        WarnSlash::MissingReason => {
            state.post_channel_notice(
                app,
                channel,
                "Failed to warn, you must specify a reason".into(),
            );
            return Ok(());
        }
        WarnSlash::ReasonTooLong => {
            state.post_channel_notice(
                app,
                channel,
                format!(
                    "Failed to warn user - reason too long (max {WARN_REASON_MAX_CHARS} characters)."
                ),
            );
            return Ok(());
        }
        WarnSlash::Action { .. } => {}
    }

    let WarnSlash::Action {
        target,
        reason,
        channels,
    } = cmd
    else {
        return Ok(());
    };

    let Some((mod_login, token)) = auth::resolved_login_token(state) else {
        state.post_channel_notice(
            app,
            channel,
            "You must be logged in to warn someone!".into(),
        );
        return Ok(());
    };
    let client_id = auth::resolved_client_id(state);
    let Some(moderator_id) = auth::ensure_twitch_user_id(state).await else {
        state.post_channel_notice(
            app,
            channel,
            "You must be logged in to warn someone!".into(),
        );
        return Ok(());
    };

    let Some(target_profile) = resolve_warn_profile(&target, &token, &client_id).await else {
        let label = target
            .login
            .clone()
            .or_else(|| target.id.as_ref().map(|id| format!("id:{id}")))
            .unwrap_or_else(|| "unknown".into());
        state.post_channel_notice(
            app,
            channel,
            format!("Failed to warn, bad target name: {label}"),
        );
        return Ok(());
    };

    let broadcaster_ids: Vec<String> = if channels.is_empty() {
        let Some(room_id) = resolve_send_room_id(state, channel) else {
            state.post_channel_notice(
                app,
                channel,
                "Sending messages in this channel isn't possible.".into(),
            );
            return Ok(());
        };
        vec![room_id]
    } else {
        let mut out = Vec::new();
        for ch_ref in channels {
            let Some(broadcaster) = resolve_warn_profile(&ch_ref, &token, &client_id).await else {
                let label = ch_ref
                    .login
                    .clone()
                    .or_else(|| ch_ref.id.as_ref().map(|id| format!("id:{id}")))
                    .unwrap_or_else(|| "unknown".into());
                state.post_channel_notice(
                    app,
                    channel,
                    format!("Failed to warn, bad channel name: {label}"),
                );
                continue;
            };
            out.push(broadcaster.id);
        }
        out
    };

    let mut last_fail: Option<String> = None;
    for broadcaster_id in broadcaster_ids {
        match super::helix::warn_user(
            &broadcaster_id,
            &moderator_id,
            &target_profile.id,
            &reason,
            &token,
            &client_id,
            &target_profile.display_name,
        )
        .await
        {
            super::helix::HelixWarnOutcome::Ok => {
                // Stock shows this via EventSub channel.moderate; until that lands,
                // emit the same system line locally so the moderator gets feedback.
                state.post_channel_notice(
                    app,
                    channel,
                    format!(
                        "{mod_login} has warned {}: {reason}",
                        target_profile.display_name
                    ),
                );
            }
            super::helix::HelixWarnOutcome::Failed(msg) => {
                // Notice for chat history; Err after the loop so UserCard/composer
                // are not silent (esp. missing moderator:manage:warnings) and
                // multi --channel still attempts every broadcaster.
                state.post_channel_notice(app, channel, msg.clone());
                last_fail = Some(msg);
            }
        }
    }
    if let Some(msg) = last_fail {
        return Err(warn_fail_api_error(msg));
    }
    Ok(())
}

fn resolve_send_room_id(state: &Shared, channel: &str) -> Option<String> {
    state
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
        })
}

fn unix_ms_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn emit_outgoing_raid(app: &AppHandle, payload: OutgoingRaidPayload) {
    let _ = app.emit("chat:outgoing_raid", payload);
}

async fn handle_raid_slash(
    app: &AppHandle,
    state: &Shared,
    channel: &str,
    cmd: RaidSlash,
) -> Result<(), ApiError> {
    match &cmd {
        RaidSlash::UsageStart => {
            state.post_channel_notice(
                app,
                channel,
                "Usage: \"/raid <username>\" - Raid a user. Only the broadcaster can start a raid."
                    .into(),
            );
            return Ok(());
        }
        RaidSlash::UsageCancel => {
            state.post_channel_notice(
                app,
                channel,
                "Usage: \"/unraid\" - Cancel the current raid. Only the broadcaster can cancel the raid."
                    .into(),
            );
            return Ok(());
        }
        RaidSlash::Start { .. } | RaidSlash::Cancel => {}
    }

    let Some(room_id) = resolve_send_room_id(state, channel) else {
        state.post_channel_notice(
            app,
            channel,
            "Sending messages in this channel isn't possible.".into(),
        );
        return Ok(());
    };
    let Some(token) = auth::oauth_token(state) else {
        let msg = match &cmd {
            RaidSlash::Start { .. } => "You must be logged in to start a raid!",
            RaidSlash::Cancel => "You must be logged in to cancel the raid!",
            RaidSlash::UsageStart | RaidSlash::UsageCancel => unreachable!(),
        };
        state.post_channel_notice(app, channel, msg.into());
        return Ok(());
    };
    let client_id = auth::resolved_client_id(state);

    match cmd {
        RaidSlash::Start { target } => {
            let Some(profile) =
                super::helix::fetch_user_profile(&target, Some(&token), &client_id).await
            else {
                state.post_channel_notice(app, channel, format!("Invalid username: {target}"));
                return Ok(());
            };
            match super::helix::start_raid(&room_id, &profile.id, &token, &client_id).await {
                super::helix::HelixRaidOutcome::Ok => {
                    emit_outgoing_raid(
                        app,
                        OutgoingRaidPayload {
                            channel: channel.to_string(),
                            active: true,
                            target_login: Some(profile.login.clone()),
                            target_display_name: Some(profile.display_name.clone()),
                            started_at_ms: Some(unix_ms_now()),
                            duration_ms: Some(OUTGOING_RAID_DURATION_MS),
                        },
                    );
                }
                super::helix::HelixRaidOutcome::Failed(msg) => {
                    state.post_channel_notice(app, channel, msg);
                }
            }
        }
        RaidSlash::Cancel => match super::helix::cancel_raid(&room_id, &token, &client_id).await {
            super::helix::HelixRaidOutcome::Ok => {
                emit_outgoing_raid(
                    app,
                    OutgoingRaidPayload {
                        channel: channel.to_string(),
                        active: false,
                        target_login: None,
                        target_display_name: None,
                        started_at_ms: None,
                        duration_ms: None,
                    },
                );
            }
            super::helix::HelixRaidOutcome::Failed(msg) => {
                state.post_channel_notice(app, channel, msg);
            }
        },
        RaidSlash::UsageStart | RaidSlash::UsageCancel => unreachable!(),
    }
    Ok(())
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
        state.post_channel_notice(app, channel, format!("{cmd} is not a known command."));
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
        ApiError::coded(
            "error.auth.required_send",
            "Twitch login required to send messages",
        )
    })?;
    let client_id = auth::resolved_client_id(state);
    if let Ok(mut last) = state.last_sent.lock() {
        last.insert(channel.to_string(), payload.clone());
    }
    super::provider_activity::post_send_activity(state.clone(), channel.to_string());
    let outcome = super::helix::send_chat_message(
        &room_id, &sender_id, &payload, reply_to, &token, &client_id,
    )
    .await;
    match outcome {
        super::helix::HelixSendOutcome::Sent => {
            super::irc::echo_own_privmsg(
                app,
                state,
                channel,
                payload,
                reply_to.map(str::to_string),
            );
            Ok(())
        }
        super::helix::HelixSendOutcome::Dropped(msg)
        | super::helix::HelixSendOutcome::Failed(msg) => {
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
pub fn session_reorder_open(
    state: tauri::State<'_, Shared>,
    open: Vec<String>,
) -> Result<super::session::Session, ApiError> {
    let normalized: Result<Vec<String>, ApiError> =
        open.into_iter().map(|c| normalize_channel(&c)).collect();
    super::session::reorder_open(&state, normalized?)
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
    let out = auth::import_blob(app, state.inner().clone(), blob).await;
    Ok(out?)
}

#[tauri::command]
pub fn auth_status(app: AppHandle, state: tauri::State<'_, Shared>) -> Result<AuthInfo, ApiError> {
    Ok(auth::snapshot(&app, &state))
}

#[tauri::command]
pub async fn auth_logout(app: AppHandle, state: tauri::State<'_, Shared>) -> Result<(), ApiError> {
    let out = auth::logout(app, state.inner().clone()).await;
    Ok(out?)
}

#[tauri::command]
pub async fn auth_select(
    app: AppHandle,
    state: tauri::State<'_, Shared>,
    login: String,
) -> Result<(), ApiError> {
    let out = auth::select_account(app, state.inner().clone(), login).await;
    Ok(out?)
}

#[tauri::command]
pub async fn auth_remove(
    app: AppHandle,
    state: tauri::State<'_, Shared>,
    login: String,
) -> Result<(), ApiError> {
    let out = auth::remove_account(app, state.inner().clone(), login).await;
    Ok(out?)
}

#[tauri::command]
pub async fn polls_vote(
    state: tauri::State<'_, Shared>,
    #[allow(non_snake_case)] pollId: String,
    #[allow(non_snake_case)] choiceId: String,
) -> Result<super::poll_actions::PollVoteResult, ApiError> {
    Ok(super::poll_actions::vote_in_poll(&state, &pollId, &choiceId).await?)
}

#[tauri::command]
pub async fn polls_predict(
    state: tauri::State<'_, Shared>,
    #[allow(non_snake_case)] eventId: String,
    #[allow(non_snake_case)] outcomeId: String,
    points: u64,
) -> Result<super::poll_actions::PredictionBetResult, ApiError> {
    Ok(super::poll_actions::make_prediction(&state, &eventId, &outcomeId, points).await?)
}

#[tauri::command]
pub fn chat_emote_popup_list(
    state: tauri::State<'_, Shared>,
    channel: String,
    tab: super::emote_popup::EmotePopupTab,
    query: String,
) -> Result<Vec<super::emote_popup::EmotePopupItem>, ApiError> {
    let login = if channel.trim().is_empty() {
        let hub = state.hub.lock().map_err(|_| ApiError::internal("lock"))?;
        hub.active.clone().unwrap_or_default()
    } else {
        normalize_channel(&channel)?
    };
    super::emote_popup::list(state.inner(), &login, tab, &query)
}

#[tauri::command]
pub fn chat_toggle_favourite_emote(
    state: tauri::State<'_, Shared>,
    code: String,
    #[allow(non_snake_case)] isEmoji: bool,
    add: bool,
) -> Result<(), ApiError> {
    super::emote_popup::toggle_favourite(state.inner(), &code, isEmoji, add)
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompleteItem {
    /// Text inserted into the composer (often with trailing space).
    pub insert: String,
    /// CDN image URL for emote/emoji rows; absent for users/commands.
    pub url: Option<String>,
    /// `emote` | `user` | `command`
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmoteIconItem {
    pub code: String,
    pub url: String,
}

const EMOTE_ICON_CODES_CAP: usize = 64;
const EMOTE_ICON_CODE_MAX: usize = 200;

fn complete_item_kind(insert: &str) -> &'static str {
    let trimmed = insert.trim_end();
    if trimmed.starts_with('/') || trimmed.starts_with('.') {
        "command"
    } else if trimmed.starts_with('@') {
        "user"
    } else {
        "emote"
    }
}

fn emoji_set_knob(shared: &Shared) -> String {
    let Ok(settings) = shared.settings.lock() else {
        return "Twitter".into();
    };
    settings
        .data
        .knobs
        .get("emotes.emojiSet")
        .and_then(|v| v.as_str())
        .unwrap_or("Twitter")
        .to_string()
}

fn resolve_composer_icon_url(
    catalog: &super::emotes::Catalog,
    channel: &str,
    code: &str,
    emoji_set: &str,
) -> Option<String> {
    if let Some(def) = catalog.lookup(channel, code) {
        if !def.url.is_empty() {
            return Some(def.url.clone());
        }
    }
    super::emoji::emoji_cdn_url(code, emoji_set)
}

fn decorate_complete_items(
    shared: &Shared,
    channel: &str,
    inserts: Vec<String>,
) -> Result<Vec<CompleteItem>, ApiError> {
    let emoji_set = emoji_set_knob(shared);
    let catalog = shared
        .catalog
        .lock()
        .map_err(|_| ApiError::internal("lock"))?;
    Ok(inserts
        .into_iter()
        .map(|insert| {
            let kind = complete_item_kind(&insert);
            let url = if kind == "emote" {
                resolve_composer_icon_url(&catalog, channel, insert.trim_end(), &emoji_set)
            } else {
                None
            };
            CompleteItem {
                insert,
                url,
                kind: kind.to_string(),
            }
        })
        .collect())
}

#[tauri::command]
pub fn chat_emote_icons(
    state: tauri::State<'_, Shared>,
    codes: Vec<String>,
) -> Result<Vec<EmoteIconItem>, ApiError> {
    if codes.len() > EMOTE_ICON_CODES_CAP {
        return Err(ApiError::coded(
            "error.emote.icons_limit",
            "too many emote codes",
        ));
    }
    let emoji_set = emoji_set_knob(state.inner());
    let channel = {
        let hub = state.hub.lock().map_err(|_| ApiError::internal("lock"))?;
        hub.active.clone().unwrap_or_default()
    };
    let catalog = state
        .catalog
        .lock()
        .map_err(|_| ApiError::internal("lock"))?;
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for raw in codes {
        if raw.chars().count() == 0 || raw.chars().count() > EMOTE_ICON_CODE_MAX {
            continue;
        }
        if raw
            .chars()
            .any(|c| matches!(c, '\0' | '\r' | '\n' | '\u{0001}'))
        {
            continue;
        }
        let code = raw.trim_end();
        if code.is_empty() || !seen.insert(code.to_string()) {
            continue;
        }
        if let Some(url) = resolve_composer_icon_url(&catalog, &channel, code, &emoji_set) {
            out.push(EmoteIconItem {
                code: code.to_string(),
                url,
            });
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn chat_complete(
    state: tauri::State<'_, Shared>,
    token: String,
    first_word: bool,
) -> Result<Vec<CompleteItem>, ApiError> {
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
    let channel = {
        let hub = state.hub.lock().map_err(|_| ApiError::internal("lock"))?;
        hub.active.clone().unwrap_or_default()
    };
    if first_word && (token.starts_with('/') || token.starts_with('.')) {
        let inserts = complete::suggestions_with_custom(
            &token,
            first_word,
            Vec::new(),
            Vec::new(),
            &custom_command_triggers(state.inner()),
        );
        return decorate_complete_items(state.inner(), &channel, inserts);
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
        drop(catalog);
        let inserts =
            complete::suggestions_with_rank(&token, first_word, emotes, Vec::new(), !smart);
        return decorate_complete_items(state.inner(), &channel, inserts);
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
        let mut ranked = complete::apply_smart_emotes(&token, pool, !prefix_only, false, false);
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
    let inserts =
        complete::suggestions_with_rank(&token, first_word, emotes, names, !smart || at_only);
    decorate_complete_items(state.inner(), &channel, inserts)
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
        return Err(ApiError::coded(
            "error.search.query_too_long",
            "search query is too long",
        ));
    }
    if query
        .chars()
        .any(|c| matches!(c, '\0' | '\r' | '\n' | '\u{0001}'))
    {
        return Err(ApiError::coded(
            "error.search.query_chars",
            "search query has invalid characters",
        ));
    }
    let mut hub = state.hub.lock().map_err(|_| ApiError::internal("lock"))?;
    if hub.active.as_deref() != Some(normalized.as_str()) {
        return Err(ApiError::coded(
            "error.channel.inactive",
            "channel is not active",
        ));
    }
    if !hub.has_channel(&normalized) {
        return Ok(SearchResult { hits: Vec::new() });
    }
    let room_id = hub.room_id(&normalized).map(str::to_string);
    let hits =
        hub.buffer(&normalized)
            .scrollback
            .search_hits(&query, &normalized, room_id.as_deref());
    Ok(SearchResult { hits })
}

#[tauri::command]
pub fn filters_get(state: tauri::State<'_, Shared>) -> Result<Filters, ApiError> {
    Ok(filters::snapshot(&state).map_err(|_| ApiError::internal("lock"))?)
}

#[tauri::command]
pub fn filters_set(state: tauri::State<'_, Shared>, filters: Filters) -> Result<Filters, ApiError> {
    filters::replace(&state, filters).map_err(|message| {
        let mut params = BTreeMap::new();
        if let Some(caps) = regex_filters_list_limit(&message) {
            params.insert("label".into(), caps.0);
            params.insert("max".into(), caps.1);
            return ApiError::coded_params("error.filters.list_limit", message, params);
        }
        if let Some(caps) = regex_filters_phrase_long(&message) {
            params.insert("label".into(), caps.0);
            params.insert("n".into(), caps.1);
            return ApiError::coded_params("error.filters.phrase_too_long", message, params);
        }
        if let Some(label) = message
            .strip_suffix(": phrase contains forbidden characters")
            .map(str::to_string)
        {
            params.insert("label".into(), label);
            return ApiError::coded_params("error.filters.phrase_chars", message, params);
        }
        let code = if message.starts_with("login:") {
            "error.filters.login"
        } else if message.contains("config directory") {
            "error.filters.config_dir"
        } else {
            "error.filters.invalid"
        };
        ApiError::coded(code, message)
    })
}

fn regex_filters_list_limit(message: &str) -> Option<(String, String)> {
    // "{label}: no more than {max} entries"
    let (label, rest) = message.split_once(": no more than ")?;
    let max = rest.strip_suffix(" entries")?;
    Some((label.to_string(), max.to_string()))
}

fn regex_filters_phrase_long(message: &str) -> Option<(String, String)> {
    // "{label}: phrase longer than {n} characters"
    let (label, rest) = message.split_once(": phrase longer than ")?;
    let n = rest.strip_suffix(" characters")?;
    Some((label.to_string(), n.to_string()))
}

#[tauri::command]
pub fn settings_get(state: tauri::State<'_, Shared>) -> Result<DisplaySettings, ApiError> {
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
pub fn chatterino1_commands_available() -> bool {
    super::chatterino1_import::chatterino1_commands_available()
}

#[tauri::command]
pub fn read_chatterino1_commands() -> Result<Vec<super::settings::CommandRow>, ApiError> {
    super::chatterino1_import::read_chatterino1_commands().map_err(ApiError::invalid)
}

#[tauri::command]
pub fn highlight_sound_read(
    state: tauri::State<'_, Shared>,
    path: Option<String>,
) -> Result<super::highlight_sound::SoundFile, ApiError> {
    super::highlight_sound::read_configured(&state, path)
}

#[tauri::command]
pub fn highlight_sound_pick(state: tauri::State<'_, Shared>) -> Result<String, ApiError> {
    super::highlight_sound::pick_path(&state)
}

#[tauri::command]
pub fn logging_pick_directory(state: tauri::State<'_, Shared>) -> Result<String, ApiError> {
    super::logging::pick_directory(&state)
}

#[tauri::command]
pub fn highlight_request_attention(
    app: tauri::AppHandle,
    long_alerts: bool,
) -> Result<(), ApiError> {
    use tauri::UserAttentionType;
    let Some(window) = app.get_webview_window("main") else {
        return Err(ApiError::coded(
            "error.window.main_unavailable",
            "main window unavailable",
        ));
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
        return Err(ApiError::coded(
            "error.auth.required_profile",
            "Twitch login required for profile",
        ));
    }
    super::helix::fetch_user_profile(&normalized, token.as_deref(), &client_id)
        .await
        .ok_or_else(|| ApiError::coded("error.user.not_found", "user not found"))
}

#[derive(Serialize)]
pub struct ProfileImageResult {
    pub login: String,
    pub url: Option<String>,
}

/// Cached Helix profile_image_url for a login; kicks background refresh when signed in and cache miss.
#[tauri::command]
pub fn chat_profile_image(
    app: AppHandle,
    state: tauri::State<'_, Shared>,
    login: String,
) -> Result<ProfileImageResult, ApiError> {
    let normalized = normalize_channel(&login)?;
    let url = super::profile_images::get(&app, &normalized);
    if url.is_none() && auth::oauth_token(&state).is_some() {
        super::profile_images::spawn_refresh_login(app, state.inner().clone(), normalized.clone());
    }
    Ok(ProfileImageResult {
        login: normalized,
        url,
    })
}

#[tauri::command]
pub async fn chat_user_followers(
    state: tauri::State<'_, Shared>,
    broadcaster_id: String,
) -> Result<Option<u64>, ApiError> {
    let id = broadcaster_id.trim();
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_digit()) {
        return Err(ApiError::coded("error.user.invalid_id", "invalid user id"));
    }
    let token = auth::oauth_token(&state);
    let client_id = auth::resolved_client_id(&state);
    let Some((client_id, token)) = super::helix::helix_creds(token.as_deref(), &client_id) else {
        return Err(ApiError::coded(
            "error.auth.required_profile",
            "Twitch login required for profile",
        ));
    };
    Ok(super::helix::fetch_channel_followers(id, &token, &client_id).await)
}

#[tauri::command]
pub async fn chat_user_pronouns(
    login: String,
) -> Result<super::pronouns::UserPronounsResult, ApiError> {
    let normalized = normalize_channel(&login)?;
    let pronouns = super::pronouns::lookup(&normalized)
        .await
        .map_err(|e| ApiError::coded("error.pronouns", e))?;
    Ok(super::pronouns::UserPronounsResult { pronouns })
}

#[tauri::command]
pub async fn chat_user_subage(
    login: String,
    channel: String,
) -> Result<super::ivr::UserSubageResult, ApiError> {
    let user = normalize_channel(&login)?;
    let channel = normalize_channel(&channel)?;
    super::ivr::fetch_subage(&user, &channel)
        .await
        .map_err(|message| ApiError::coded("error.ivr", message))
}

#[tauri::command]
pub fn chat_user_notes(
    state: tauri::State<'_, Shared>,
    #[allow(non_snake_case)] userId: String,
) -> Result<super::user_data::UserNotesResult, ApiError> {
    let notes = super::user_data::get_notes(&state, userId.trim())
        .map_err(|message| ApiError::coded("error.notes.invalid", message))?;
    Ok(super::user_data::UserNotesResult { notes })
}

#[tauri::command]
pub fn chat_set_user_notes(
    state: tauri::State<'_, Shared>,
    #[allow(non_snake_case)] userId: String,
    notes: String,
) -> Result<(), ApiError> {
    super::user_data::set_notes(&state, userId.trim(), &notes).map_err(|message| {
        if message.contains("too long") || message.contains("invalid") {
            ApiError::coded("error.notes.invalid", message)
        } else {
            ApiError::internal(&message)
        }
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewerRoleDto {
    pub is_mod: bool,
    pub is_broadcaster: bool,
}

#[tauri::command]
pub fn chat_viewer_role(
    state: tauri::State<'_, Shared>,
    channel: String,
) -> Result<ViewerRoleDto, ApiError> {
    let normalized = normalize_channel(&channel)?;
    let hub = state.hub.lock().map_err(|_| ApiError::internal("lock"))?;
    let role = hub.viewer_role(
        &normalized,
        auth::resolved_twitch_user_id(&state).as_deref(),
    );
    Ok(ViewerRoleDto {
        is_mod: role.is_mod,
        is_broadcaster: role.is_broadcaster,
    })
}

/// Runtime Helix block list logins (Settings Ignores → Users). Empty when anon / unloaded.
#[tauri::command]
pub fn chat_blocked_users(state: tauri::State<'_, Shared>) -> Result<Vec<String>, ApiError> {
    let guard = state
        .twitch_blocks
        .lock()
        .map_err(|_| ApiError::internal("lock"))?;
    Ok(guard.list_logins())
}

#[tauri::command]
pub fn chat_user_blocked(
    state: tauri::State<'_, Shared>,
    #[allow(non_snake_case)] userId: String,
    login: String,
) -> Result<bool, ApiError> {
    let guard = state
        .twitch_blocks
        .lock()
        .map_err(|_| ApiError::internal("lock"))?;
    Ok(super::twitch_blocks::is_user_blocked(
        &guard,
        userId.trim(),
        login.trim(),
    ))
}

#[tauri::command]
pub async fn chat_set_user_blocked(
    state: tauri::State<'_, Shared>,
    #[allow(non_snake_case)] userId: String,
    login: String,
    blocked: bool,
) -> Result<(), ApiError> {
    super::twitch_blocks::set_user_blocked(&state, userId.trim(), login.trim(), blocked)
        .await
        .map_err(|message| {
            if message.contains("not logged in") {
                ApiError::coded("error.auth.required", message)
            } else if message.contains("permission") {
                ApiError::coded("error.helix.forbidden", message)
            } else {
                ApiError::coded("error.helix", message)
            }
        })
}

#[tauri::command]
pub fn chat_user_ignore_highlights(
    state: tauri::State<'_, Shared>,
    login: String,
) -> Result<super::highlight_blacklist::IgnoreHighlightsState, ApiError> {
    super::highlight_blacklist::query_state(&state, login.trim())
        .map_err(|message| ApiError::internal(&message))
}

#[tauri::command]
pub fn chat_set_user_ignore_highlights(
    state: tauri::State<'_, Shared>,
    login: String,
    ignored: bool,
) -> Result<(), ApiError> {
    super::highlight_blacklist::set_user_ignore_highlights(&state, login.trim(), ignored)
        .map_err(|message| ApiError::internal(&message))
}

#[tauri::command]
pub fn supports_incognito_links() -> bool {
    super::incognito::supports_incognito()
}

#[tauri::command]
pub fn open_chat_link(url: String, private: Option<bool>) -> Result<(), ApiError> {
    let allowed = allowed_chat_url(&url).map_err(|message| {
        let code = match message.as_str() {
            "invalid url" => "error.url.invalid",
            "only http or https" => "error.url.scheme",
            "missing host" => "error.url.host",
            "userinfo not allowed" => "error.url.userinfo",
            _ => "error.url.invalid",
        };
        ApiError::coded(code, message)
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AboutInfo {
    pub version: String,
    pub settings_directory: String,
}

fn settings_directory_path(shared: &Shared) -> Result<std::path::PathBuf, ApiError> {
    let guard = shared
        .settings
        .lock()
        .map_err(|_| ApiError::internal("settings lock"))?;
    let file = &guard.path;
    if file.as_os_str().is_empty() {
        return Err(ApiError::internal("settings path unset"));
    }
    let dir = file
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| ApiError::internal("settings directory missing"))?;
    Ok(dir.to_path_buf())
}

#[tauri::command]
pub fn about_info(state: tauri::State<'_, Shared>) -> Result<AboutInfo, ApiError> {
    let dir = settings_directory_path(state.inner())?;
    Ok(AboutInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        settings_directory: dir.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub fn open_settings_directory(state: tauri::State<'_, Shared>) -> Result<(), ApiError> {
    let dir = settings_directory_path(state.inner())?;
    tauri_plugin_opener::open_path(&dir, None::<&str>)
        .map_err(|e| ApiError::internal(&e.to_string()))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CdnImageBytes {
    pub bytes: Vec<u8>,
    pub content_type: Option<String>,
}

#[tauri::command]
pub async fn fetch_emote_cdn(url: String) -> Result<CdnImageBytes, ApiError> {
    let (bytes, content_type) = super::fetch::fetch_cdn_image(&url)
        .await
        .map_err(|message| ApiError::invalid(&message))?;
    Ok(CdnImageBytes {
        bytes,
        content_type,
    })
}

#[tauri::command]
pub fn open_settings_window(app: tauri::AppHandle) -> Result<(), ApiError> {
    let Some(window) = app.get_webview_window("settings") else {
        return Err(ApiError::internal("settings window unavailable"));
    };
    if window.is_visible().unwrap_or(false) {
        window
            .set_focus()
            .map_err(|e| ApiError::internal(&e.to_string()))?;
    } else {
        window
            .show()
            .map_err(|e| ApiError::internal(&e.to_string()))?;
        window
            .set_focus()
            .map_err(|e| ApiError::internal(&e.to_string()))?;
    }
    Ok(())
}

#[tauri::command]
pub fn cache_info(
    app: AppHandle,
    state: tauri::State<'_, Shared>,
) -> Result<super::cache::CacheInfo, ApiError> {
    super::cache::info(&app, state.inner())
}

#[tauri::command]
pub fn cache_pick_directory() -> Result<String, ApiError> {
    super::cache::pick_directory()
}

#[tauri::command]
pub fn cache_clear(app: AppHandle, state: tauri::State<'_, Shared>) -> Result<(), ApiError> {
    super::cache::clear(&app, state.inner())
}

#[tauri::command]
pub async fn image_upload(
    app: AppHandle,
    state: tauri::State<'_, Shared>,
    channel: String,
    #[allow(non_snake_case)] bytesBase64: String,
    format: String,
) -> Result<super::image_uploader::UploadResult, ApiError> {
    let login = normalize_channel(&channel)?;
    let fmt = super::image_uploader::normalize_format(&format)
        .map_err(|message| ApiError::coded("error.upload.format", message))?;
    let cfg = super::image_uploader::load_config(state.inner())
        .map_err(|message| ApiError::coded("error.upload.config", message))?;
    let _guard = super::image_uploader::try_begin_upload()
        .map_err(|message| ApiError::coded("error.upload.busy", message))?;
    let bytes = super::image_uploader::decode_bytes(&bytesBase64)
        .map_err(|message| ApiError::coded("error.upload.decode", message))?;
    if bytes.len() > super::image_uploader::MAX_IMAGE_BYTES {
        let max_mib = super::image_uploader::MAX_IMAGE_BYTES / (1024 * 1024);
        return Err(ApiError::coded_params(
            "error.upload.too_large",
            format!("Image is too large (max {max_mib} MiB)."),
            BTreeMap::from([("max".into(), max_mib.to_string())]),
        ));
    }
    state.post_channel_notice(&app, &login, "Started upload...".into());
    let result = super::image_uploader::post_image(&cfg, bytes, fmt).await;
    match result {
        Ok(ok) => {
            state.post_channel_notice(
                &app,
                &login,
                super::image_uploader::success_notice(&ok.link, &ok.deletion_link),
            );
            Ok(ok)
        }
        Err(message) => {
            state.post_channel_notice(&app, &login, message.clone());
            Err(ApiError::internal(&message))
        }
    }
}

#[tauri::command]
pub fn open_in_streamlink(
    state: tauri::State<'_, Shared>,
    channel: String,
) -> Result<(), ApiError> {
    super::streamlink::open_for_channel(state.inner(), &channel).map_err(|message| {
        if message.contains("channel name")
            || message.contains("custom path")
            || message.contains("options")
            || message.contains("Unable to find")
        {
            ApiError::coded("error.streamlink.invalid", message)
        } else {
            ApiError::internal(&message)
        }
    })
}

#[tauri::command]
pub fn open_in_custom_player(
    state: tauri::State<'_, Shared>,
    channel: String,
) -> Result<(), ApiError> {
    super::custom_player::open_for_channel(state.inner(), &channel).map_err(|message| {
        if message.contains("channel name")
            || message.contains("URI scheme")
            || message.contains("forbidden")
        {
            ApiError::coded("error.player.invalid", message)
        } else {
            ApiError::internal(&message)
        }
    })
}

pub fn normalize_channel(raw: &str) -> Result<String, ApiError> {
    let s = raw.trim().trim_start_matches('#').to_lowercase();
    if s.is_empty() || s.len() > 25 || !s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err(ApiError::coded(
            "error.channel.name",
            "channel name: 1-25 characters [a-z0-9_]",
        ));
    }
    Ok(s)
}

pub fn format_outgoing(raw: &str) -> Result<String, ApiError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(ApiError::coded("error.message.empty", "message is empty"));
    }
    if trimmed.chars().count() > MAX_CHAT_CHARS {
        return Err(ApiError::coded_params(
            "error.message.too_long",
            format!("message longer than {MAX_CHAT_CHARS} characters"),
            BTreeMap::from([("max".into(), MAX_CHAT_CHARS.to_string())]),
        ));
    }
    if trimmed
        .chars()
        .any(|c| matches!(c, '\0' | '\r' | '\n' | '\u{0001}'))
    {
        return Err(ApiError::coded(
            "error.message.forbidden_chars",
            "message contains forbidden characters",
        ));
    }
    if trimmed.starts_with('/') {
        let mut parts = trimmed.splitn(2, char::is_whitespace);
        let cmd = parts.next().unwrap_or("");
        let rest = parts.next().unwrap_or("").trim();
        if cmd.eq_ignore_ascii_case("/me") {
            if rest.is_empty() {
                return Err(ApiError::coded(
                    "error.message.me_empty",
                    "empty /me action",
                ));
            }
            let wire = format!("\u{0001}ACTION {rest}\u{0001}");
            if wire.chars().count() > MAX_CHAT_CHARS {
                return Err(ApiError::coded_params(
                    "error.message.too_long",
                    format!("message longer than {MAX_CHAT_CHARS} characters"),
                    BTreeMap::from([("max".into(), MAX_CHAT_CHARS.to_string())]),
                ));
            }
            return Ok(wire);
        }
        let name = cmd.trim_start_matches('/');
        if !complete::is_known_command(name) {
            return Err(ApiError::coded(
                "error.command.unknown_slash",
                "unknown slash command",
            ));
        }
    }
    Ok(trimmed.to_string())
}

pub fn format_outgoing_helix(raw: &str) -> Result<String, ApiError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(ApiError::coded("error.message.empty", "message is empty"));
    }
    if trimmed.chars().count() > MAX_CHAT_CHARS {
        return Err(ApiError::coded_params(
            "error.message.too_long",
            format!("message longer than {MAX_CHAT_CHARS} characters"),
            BTreeMap::from([("max".into(), MAX_CHAT_CHARS.to_string())]),
        ));
    }
    if trimmed
        .chars()
        .any(|c| matches!(c, '\0' | '\r' | '\n' | '\u{0001}'))
    {
        return Err(ApiError::coded(
            "error.message.forbidden_chars",
            "message contains forbidden characters",
        ));
    }
    if trimmed.starts_with('/') {
        let mut parts = trimmed.splitn(2, char::is_whitespace);
        let cmd = parts.next().unwrap_or("");
        let rest = parts.next().unwrap_or("").trim();
        if cmd.eq_ignore_ascii_case("/me") && rest.is_empty() {
            return Err(ApiError::coded(
                "error.message.me_empty",
                "empty /me action",
            ));
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
        return Err(ApiError::coded(
            "error.message.reply_id",
            "invalid reply id",
        ));
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(ApiError::coded(
            "error.message.reply_id",
            "invalid reply id",
        ));
    }
    Ok(id.to_string())
}

async fn send_cmd(state: &Shared, cmd: IrcCmd) -> Result<(), ApiError> {
    let tx = state
        .irc_tx
        .lock()
        .map_err(|_| ApiError::internal("lock"))?
        .clone()
        .ok_or_else(|| ApiError::internal("irc not running"))?;
    tokio::time::timeout(Duration::from_secs(10), tx.send(cmd))
        .await
        .map_err(|_| ApiError::internal("irc queue timeout"))?
        .map_err(|_| ApiError::internal("irc queue"))?;
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
    fn settings_directory_from_file_path() {
        let file = std::path::PathBuf::from("/tmp/app/settings.json");
        let dir = file.parent().expect("parent");
        assert_eq!(dir, std::path::Path::new("/tmp/app"));
        assert_eq!(env!("CARGO_PKG_VERSION").is_empty(), false);
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
    fn parse_raid_slash_commands() {
        assert_eq!(
            parse_raid_slash("/raid Foobar"),
            Some(RaidSlash::Start {
                target: "foobar".into()
            })
        );
        assert_eq!(
            parse_raid_slash(".raid @Foo_Bar"),
            Some(RaidSlash::Start {
                target: "foo_bar".into()
            })
        );
        assert_eq!(parse_raid_slash("/unraid"), Some(RaidSlash::Cancel));
        assert_eq!(parse_raid_slash("/raid"), Some(RaidSlash::UsageStart));
        assert_eq!(parse_raid_slash("/raid a b"), Some(RaidSlash::UsageStart));
        assert_eq!(parse_raid_slash("/unraid x"), Some(RaidSlash::UsageCancel));
        assert_eq!(parse_raid_slash("/me waves"), None);
        assert_eq!(parse_raid_slash("raid foo"), None);
    }

    #[test]
    fn parse_warn_slash_commands() {
        assert_eq!(parse_warn_slash("/me waves"), None);
        assert_eq!(parse_warn_slash("/warn"), Some(WarnSlash::Usage));
        assert_eq!(
            parse_warn_slash("/warn someone"),
            Some(WarnSlash::MissingReason)
        );
        assert_eq!(
            parse_warn_slash("/warn @Foo_Bar be nice"),
            Some(WarnSlash::Action {
                target: WarnTargetRef {
                    login: Some("foo_bar".into()),
                    id: None,
                },
                reason: "be nice".into(),
                channels: vec![],
            })
        );
        assert_eq!(
            parse_warn_slash(".warn id:123 spam links"),
            Some(WarnSlash::Action {
                target: WarnTargetRef {
                    login: None,
                    id: Some("123".into()),
                },
                reason: "spam links".into(),
                channels: vec![],
            })
        );
        assert_eq!(
            parse_warn_slash("/warn --channel other target please stop"),
            Some(WarnSlash::Action {
                target: WarnTargetRef {
                    login: Some("target".into()),
                    id: None,
                },
                reason: "please stop".into(),
                channels: vec![WarnTargetRef {
                    login: Some("other".into()),
                    id: None,
                }],
            })
        );
        assert_eq!(parse_warn_slash("/warn --channel"), Some(WarnSlash::Usage));
        let long = "x".repeat(501);
        assert_eq!(
            parse_warn_slash(&format!("/warn bob {long}")),
            Some(WarnSlash::ReasonTooLong)
        );
        let ok_reason = "x".repeat(500);
        assert!(matches!(
            parse_warn_slash(&format!("/warn bob {ok_reason}")),
            Some(WarnSlash::Action { .. })
        ));
        assert!(looks_like_warn_slash("/warn bob reason"));
        assert!(!looks_like_warn_slash("/ban bob"));
    }

    #[test]
    fn chat_send_protocol_modes() {
        let shared = Shared::new();
        assert!(!should_send_helix(&shared));
        {
            let mut settings = shared.settings.lock().unwrap();
            settings.data.knobs.insert(
                "misc.chatSendProtocol".into(),
                Value::String("Helix".into()),
            );
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
    fn resolve_send_channel_prefers_explicit_joined() {
        let shared = Shared::new();
        {
            let mut hub = shared.hub.lock().unwrap();
            let _ = hub.buffer("alpha");
            hub.set_joined("alpha", true);
            let _ = hub.buffer("beta");
            hub.set_joined("beta", true);
            hub.active = Some("beta".into());
        }
        assert_eq!(
            resolve_send_channel(&shared, Some("alpha")).unwrap(),
            "alpha"
        );
        assert_eq!(resolve_send_channel(&shared, None).unwrap(), "beta");
        assert_eq!(
            resolve_send_channel(&shared, Some("#Alpha")).unwrap(),
            "alpha"
        );
    }

    #[test]
    fn resolve_send_channel_rejects_unjoined_or_closed() {
        let shared = Shared::new();
        {
            let mut hub = shared.hub.lock().unwrap();
            let _ = hub.buffer("alpha");
            hub.set_joined("alpha", true);
            hub.active = Some("alpha".into());
        }
        assert_eq!(
            resolve_send_channel(&shared, Some("ghost"))
                .unwrap_err()
                .code,
            "error.channel.not_joined"
        );
        {
            let mut hub = shared.hub.lock().unwrap();
            let _ = hub.buffer("stale");
            // buffer open but not IRC-joined
        }
        assert_eq!(
            resolve_send_channel(&shared, Some("stale"))
                .unwrap_err()
                .code,
            "error.channel.not_joined"
        );
    }

    #[test]
    fn warn_fail_api_error_codes_scope() {
        let scope = warn_fail_api_error(
            "Failed to warn user - Missing required scope. Re-login with your account and try again."
                .into(),
        );
        assert_eq!(scope.code, "error.warn.scope");
        let other = warn_fail_api_error("Failed to warn user - conflict".into());
        assert_eq!(other.code, "warn.failed");
        assert_eq!(other.message, "Failed to warn user - conflict");
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

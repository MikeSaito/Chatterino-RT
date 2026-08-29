// MIT reimpl: Chatterino TwitchChannel shared chat session + MessageBuilder shared badge.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use super::auth;
use super::helix::{self, UserProfile};
use super::state::Shared;
use super::types::Badge;

const PROBE_DEBOUNCE: Duration = Duration::from_secs(30);
const ATTEMPTS: u32 = 3;
/// Allowlisted Twitch placeholder when source profile is not cached yet.
const FALLBACK_PROFILE_URL: &str =
    "https://static-cdn.jtvnw.net/jtv_user_pictures/anonymous-user-profile_image-300x300.png";

static SHUTDOWN: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SharedChatChannelState {
    pub participant_ids: Vec<String>,
    last_probe: Option<Instant>,
}

#[derive(Debug, Default)]
pub struct SharedChatState {
    pub channels: HashMap<String, SharedChatChannelState>,
    pub users_by_room: HashMap<String, UserProfile>,
    badge_load_pending: HashSet<String>,
    refresh_inflight: HashSet<String>,
}

impl SharedChatState {
    pub fn clear(&mut self) {
        self.channels.clear();
        self.users_by_room.clear();
        self.badge_load_pending.clear();
        self.refresh_inflight.clear();
    }
}

pub fn clear(shared: &Shared) {
    if let Ok(mut slot) = shared.shared_chat.lock() {
        slot.clear();
    }
}

pub fn shutdown() {
    SHUTDOWN.store(true, Ordering::SeqCst);
}

pub fn start(shared: Shared) {
    tauri::async_runtime::spawn(async move {
        run_poller(shared).await;
    });
}

async fn run_poller(shared: Shared) {
    loop {
        if SHUTDOWN.load(Ordering::SeqCst) {
            break;
        }
        let interval = refresh_interval_secs(&shared);
        tokio::time::sleep(Duration::from_secs(interval)).await;
        if SHUTDOWN.load(Ordering::SeqCst) {
            break;
        }
        refresh_joined_channels(&shared).await;
    }
}

pub fn maybe_probe(shared: &Shared, channel: &str, room_id: &str) {
    let now = Instant::now();
    let should = shared
        .shared_chat
        .lock()
        .ok()
        .and_then(|state| state.channels.get(channel).map(|ch| ch.last_probe))
        .flatten()
        .is_none_or(|last| now.duration_since(last) >= PROBE_DEBOUNCE);
    if !should {
        return;
    }
    spawn_refresh(shared, channel.to_string(), room_id.to_string());
}

pub fn spawn_refresh(shared: &Shared, channel: String, room_id: String) {
    {
        let Ok(mut state) = shared.shared_chat.lock() else {
            return;
        };
        if state.refresh_inflight.contains(&channel) {
            return;
        }
        state.refresh_inflight.insert(channel.clone());
    }
    let shared = shared.clone();
    tauri::async_runtime::spawn(async move {
        refresh_channel(&shared, &channel, &room_id).await;
        if let Ok(mut state) = shared.shared_chat.lock() {
            state.refresh_inflight.remove(&channel);
        }
    });
}

pub fn has_active_session(shared: &Shared, channel: &str) -> bool {
    shared
        .shared_chat
        .lock()
        .ok()
        .and_then(|state| state.channels.get(channel).cloned())
        .is_some_and(|ch| !ch.participant_ids.is_empty())
}

pub fn should_show_badge(is_shared: bool, always: bool, session_active: bool) -> bool {
    is_shared || (always && session_active)
}

pub fn is_shared_message(source_room_id: Option<&str>, current_room_id: Option<&str>) -> bool {
    match (
        source_room_id.filter(|s| !s.is_empty()),
        current_room_id.filter(|s| !s.is_empty()),
    ) {
        (Some(src), Some(cur)) => src != cur,
        _ => false,
    }
}

pub fn apply_badges(
    shared: &Shared,
    channel: &str,
    badges: &mut Vec<Badge>,
    source_room_id: Option<&str>,
    source_badges: &[Badge],
) {
    let current_room_id = shared
        .hub
        .lock()
        .ok()
        .and_then(|hub| hub.room_id(channel).map(str::to_string));
    let is_shared = is_shared_message(source_room_id, current_room_id.as_deref());
    let (always, _) = knobs(&shared);
    let session_active = has_active_session(shared, channel);
    if !should_show_badge(is_shared, always, session_active) {
        return;
    }

    let (source_name, profile_url, source_login) =
        resolve_source_display(shared, channel, source_room_id, current_room_id.as_deref());

    if let Some(room_id) = source_room_id.filter(|s| !s.is_empty()) {
        ensure_user_cached(shared, room_id);
    }

    let badge_url = profile_url
        .as_deref()
        .and_then(helix::shared_chat_profile_badge_url)
        .or_else(fallback_shared_chat_badge_url);

    if let Some(url) = badge_url {
        badges.insert(
            0,
            Badge {
                set: "shared_chat".into(),
                version: "1".into(),
                url: Some(url),
                source: "twitch".into(),
                tooltip: Some(shared_tooltip(source_name.as_deref())),
            },
        );
    }

    if !is_shared || source_badges.is_empty() {
        return;
    }

    let Some(src_room) = source_room_id.filter(|s| !s.is_empty()) else {
        return;
    };
    let source_login = source_login.or_else(|| {
        shared
            .shared_chat
            .lock()
            .ok()
            .and_then(|state| state.users_by_room.get(src_room).map(|u| u.login.clone()))
    });
    let Some(source_login) = source_login else {
        spawn_user_fetch(shared, src_room);
        return;
    };

    ensure_source_badges_loaded(shared, &source_login, src_room);

    let source_channel_name = source_name.unwrap_or_else(|| source_login.clone());
    let source_sets: Vec<String> = source_badges
        .iter()
        .filter(|b| is_authority_badge(&b.set))
        .map(|b| b.set.clone())
        .collect();
    if !source_sets.is_empty() {
        dedup_local_authority_badges(badges, &source_sets);
    }

    if let Ok(cat) = shared.badges.lock() {
        for src in source_badges {
            if !is_authority_badge(&src.set) {
                continue;
            }
            let mut badge = src.clone();
            if badge.url.is_none() {
                if let Some(url) = cat.lookup(&source_login, &badge.set, &badge.version) {
                    badge.url = Some(url.to_string());
                }
            }
            if badge.url.is_none() {
                continue;
            }
            badge.tooltip = Some(format!(
                "{} ({})",
                authority_tooltip(&badge.set),
                source_channel_name
            ));
            badges.push(badge);
        }
    }
}

fn resolve_source_display(
    shared: &Shared,
    channel: &str,
    source_room_id: Option<&str>,
    current_room_id: Option<&str>,
) -> (Option<String>, Option<String>, Option<String>) {
    if let Some(src) = source_room_id.filter(|s| !s.is_empty()) {
        if current_room_id.is_some_and(|cur| cur == src) {
            if let Ok(state) = shared.shared_chat.lock() {
                if let Some(user) = state.users_by_room.get(src) {
                    return (
                        Some(channel.to_string()),
                        user.profile_image_url.clone(),
                        Some(user.login.clone()),
                    );
                }
            }
            return (Some(channel.to_string()), None, None);
        }
        if let Ok(state) = shared.shared_chat.lock() {
            if let Some(user) = state.users_by_room.get(src) {
                return (
                    Some(user.display_name.clone()),
                    user.profile_image_url.clone(),
                    Some(user.login.clone()),
                );
            }
        }
        return (None, None, None);
    }

    (None, None, None)
}

fn fallback_shared_chat_badge_url() -> Option<String> {
    helix::shared_chat_profile_badge_url(FALLBACK_PROFILE_URL)
}

fn shared_tooltip(source_name: Option<&str>) -> String {
    match source_name.filter(|s| !s.is_empty()) {
        Some(name) => format!("Shared Message from {name}"),
        None => "Shared Message".into(),
    }
}

fn authority_tooltip(set: &str) -> String {
    match set.to_ascii_lowercase().as_str() {
        "moderator" => "Moderator".into(),
        "vip" => "VIP".into(),
        "lead_moderator" => "Lead Moderator".into(),
        other => other.to_string(),
    }
}

fn is_authority_badge(set: &str) -> bool {
    matches!(
        set.to_ascii_lowercase().as_str(),
        "moderator" | "vip" | "lead_moderator"
    )
}

fn dedup_local_authority_badges(badges: &mut Vec<Badge>, source_sets: &[String]) {
    badges.retain(|b| {
        !is_authority_badge(&b.set) || !source_sets.iter().any(|s| s.eq_ignore_ascii_case(&b.set))
    });
}

fn ensure_user_cached(shared: &Shared, room_id: &str) {
    let cached = shared
        .shared_chat
        .lock()
        .ok()
        .is_some_and(|state| state.users_by_room.contains_key(room_id));
    if !cached {
        spawn_user_fetch(shared, room_id);
    }
}

fn spawn_user_fetch(shared: &Shared, room_id: &str) {
    let shared = shared.clone();
    let room_id = room_id.to_string();
    tauri::async_runtime::spawn(async move {
        fetch_users_into_cache(&shared, &[room_id]).await;
    });
}

fn ensure_source_badges_loaded(shared: &Shared, source_login: &str, source_room_id: &str) {
    let already = shared
        .badges
        .lock()
        .ok()
        .is_some_and(|cat| cat.has_channel(source_login));
    if already {
        return;
    }
    let pending = shared
        .shared_chat
        .lock()
        .ok()
        .is_some_and(|state| state.badge_load_pending.contains(source_room_id));
    if pending {
        return;
    }
    if let Ok(mut state) = shared.shared_chat.lock() {
        state.badge_load_pending.insert(source_room_id.to_string());
    }
    let shared = shared.clone();
    let source_login = source_login.to_string();
    let source_room_id = source_room_id.to_string();
    tauri::async_runtime::spawn(async move {
        let token = auth::oauth_token(&shared);
        let client_id = auth::resolved_client_id(&shared);
        helix::load_channel_badges_for_login(
            &shared.badges,
            &source_login,
            &source_room_id,
            token.as_deref(),
            &client_id,
        )
        .await;
        if let Ok(mut state) = shared.shared_chat.lock() {
            state.badge_load_pending.remove(&source_room_id);
        }
    });
}

async fn refresh_joined_channels(shared: &Shared) {
    let channels: Vec<(String, String)> = shared
        .hub
        .lock()
        .ok()
        .map(|hub| {
            hub.joined_channels()
                .into_iter()
                .filter_map(|login| hub.room_id(&login).map(|rid| (login, rid.to_string())))
                .collect()
        })
        .unwrap_or_default();
    for (channel, room_id) in channels {
        refresh_channel(shared, &channel, &room_id).await;
    }
}

async fn refresh_channel(shared: &Shared, channel: &str, host_room_id: &str) {
    if let Ok(mut state) = shared.shared_chat.lock() {
        state
            .channels
            .entry(channel.to_string())
            .or_default()
            .last_probe = Some(Instant::now());
    }

    let token = auth::oauth_token(shared);
    let client_id = auth::resolved_client_id(shared);
    let participants =
        match helix::fetch_shared_chat_session(host_room_id, token.as_deref(), &client_id).await {
            Some(ids) => ids,
            None => return,
        };

    let guest_ids: Vec<String> = participants
        .iter()
        .filter(|id| id.as_str() != host_room_id)
        .cloned()
        .collect();

    let changed = shared
        .shared_chat
        .lock()
        .ok()
        .and_then(|state| state.channels.get(channel).cloned())
        .is_none_or(|prev| prev.participant_ids != guest_ids);

    if let Ok(mut state) = shared.shared_chat.lock() {
        let slot = state.channels.entry(channel.to_string()).or_default();
        slot.participant_ids = guest_ids.clone();
    }

    if changed && !participants.is_empty() {
        fetch_users_into_cache(shared, &participants).await;
    }
}

async fn fetch_users_into_cache(shared: &Shared, room_ids: &[String]) {
    if room_ids.is_empty() {
        return;
    }
    let token = auth::oauth_token(shared);
    let client_id = auth::resolved_client_id(shared);
    let mut delay = Duration::from_secs(2);
    for _ in 0..ATTEMPTS {
        let map = helix::fetch_users_by_ids(room_ids, token.as_deref(), &client_id).await;
        if !map.is_empty() {
            if let Ok(mut state) = shared.shared_chat.lock() {
                state.users_by_room.extend(map);
            }
            return;
        }
        tokio::time::sleep(delay).await;
        delay = delay.saturating_mul(2).min(Duration::from_secs(60));
    }
}

fn knobs(shared: &Shared) -> (bool, u64) {
    shared
        .settings
        .lock()
        .ok()
        .map(|inner| {
            let knobs = &inner.data.knobs;
            let always = knobs
                .get("behaviour.sharedChatAlwaysShowBadge")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            let interval = knobs
                .get("behaviour.sharedChatSessionRefreshInterval")
                .and_then(|v| v.as_u64())
                .unwrap_or(60)
                .clamp(5, 999);
            (always, interval)
        })
        .unwrap_or((true, 60))
}

fn refresh_interval_secs(shared: &Shared) -> u64 {
    knobs(shared).1
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn should_show_respects_shared_and_always() {
        assert!(should_show_badge(true, false, false));
        assert!(should_show_badge(false, true, true));
        assert!(!should_show_badge(false, true, false));
        assert!(!should_show_badge(false, false, true));
    }

    #[test]
    fn is_shared_message_requires_different_room() {
        assert!(is_shared_message(Some("2"), Some("1")));
        assert!(!is_shared_message(Some("1"), Some("1")));
        assert!(!is_shared_message(None, Some("1")));
        assert!(!is_shared_message(Some("1"), None));
    }

    #[test]
    fn dedup_removes_local_authority_before_source_append() {
        let mut badges = vec![
            Badge {
                set: "moderator".into(),
                version: "1".into(),
                url: Some("https://static-cdn.jtvnw.net/local-mod.png".into()),
                source: "twitch".into(),
                tooltip: None,
            },
            Badge {
                set: "subscriber".into(),
                version: "6".into(),
                url: Some("https://static-cdn.jtvnw.net/sub.png".into()),
                source: "twitch".into(),
                tooltip: None,
            },
        ];
        dedup_local_authority_badges(&mut badges, &["moderator".into()]);
        badges.push(Badge {
            set: "moderator".into(),
            version: "1".into(),
            url: Some("https://static-cdn.jtvnw.net/source-mod.png".into()),
            source: "twitch".into(),
            tooltip: Some("Moderator (Guest)".into()),
        });
        assert_eq!(badges.len(), 2);
        assert_eq!(badges[0].set, "subscriber");
        assert_eq!(badges[1].set, "moderator");
        assert_eq!(
            badges[1].url.as_deref(),
            Some("https://static-cdn.jtvnw.net/source-mod.png")
        );
    }

    #[test]
    fn fallback_shared_chat_badge_url_is_allowlisted() {
        assert!(fallback_shared_chat_badge_url().is_some());
    }

    #[test]
    fn shared_tooltip_formats_name() {
        assert_eq!(shared_tooltip(Some("Ann")), "Shared Message from Ann");
        assert_eq!(shared_tooltip(None), "Shared Message");
    }
}

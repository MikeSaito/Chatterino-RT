// MIT reimpl: Chatterino IgnoreController + Helix::loadBlocks.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use url::Url;

use super::auth;
use super::state::Shared;

const HELIX: &str = "https://api.twitch.tv/helix";
const BLOCK_LIMIT: usize = 1000;
const ATTEMPTS: u32 = 3;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ViewerRole {
    pub is_mod: bool,
    pub is_broadcaster: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockedUserShow {
    Never,
    IfModerator,
    IfBroadcaster,
}

impl BlockedUserShow {
    pub fn from_knob(raw: &str) -> Self {
        match raw {
            "1" => Self::IfModerator,
            "2" => Self::IfBroadcaster,
            _ => Self::Never,
        }
    }
}

pub fn should_drop_blocked_user(
    blocks: &TwitchBlockSet,
    enabled: bool,
    show: BlockedUserShow,
    viewer: ViewerRole,
    user_id: Option<&str>,
    login: Option<&str>,
    self_login: Option<&str>,
) -> bool {
    if !enabled {
        return false;
    }
    if let Some(login) = login {
        if self_login.is_some_and(|me| me.eq_ignore_ascii_case(login)) {
            return false;
        }
    }
    if !blocks.is_blocked(user_id, login) {
        return false;
    }
    match show {
        BlockedUserShow::Never => true,
        BlockedUserShow::IfModerator => !(viewer.is_mod || viewer.is_broadcaster),
        BlockedUserShow::IfBroadcaster => !viewer.is_broadcaster,
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TwitchBlockSet {
    user_ids: HashSet<String>,
    logins: HashSet<String>,
}

impl TwitchBlockSet {
    pub fn clear(&mut self) {
        self.user_ids.clear();
        self.logins.clear();
    }

    pub fn replace(&mut self, parsed: TwitchBlockSet) {
        *self = parsed;
    }

    pub fn is_blocked(&self, user_id: Option<&str>, login: Option<&str>) -> bool {
        if let Some(id) = user_id.filter(|s| !s.is_empty()) {
            if self.user_ids.contains(id) {
                return true;
            }
        }
        if let Some(login) = login.filter(|s| !s.is_empty()) {
            let key = login.to_ascii_lowercase();
            if self.logins.contains(&key) {
                return true;
            }
        }
        false
    }

    pub fn merge_page(&mut self, page: &TwitchBlockSet) {
        self.user_ids.extend(page.user_ids.iter().cloned());
        self.logins.extend(page.logins.iter().cloned());
    }

    pub fn insert_user(&mut self, user_id: &str, login: &str) {
        if !user_id.is_empty() && user_id.chars().all(|c| c.is_ascii_digit()) {
            self.user_ids.insert(user_id.to_string());
        }
        let key = login.trim().to_ascii_lowercase();
        if !key.is_empty() {
            self.logins.insert(key);
        }
    }

    pub fn remove_user(&mut self, user_id: &str, login: &str) {
        if !user_id.is_empty() {
            self.user_ids.remove(user_id);
        }
        let key = login.trim().to_ascii_lowercase();
        if !key.is_empty() {
            self.logins.remove(&key);
        }
    }

    /// Sorted display logins for Settings Ignores → Users (stock QListView).
    pub fn list_logins(&self) -> Vec<String> {
        let mut out: Vec<String> = self.logins.iter().cloned().collect();
        out.sort_by(|a, b| a.to_ascii_lowercase().cmp(&b.to_ascii_lowercase()));
        out
    }
}

pub fn is_user_blocked(blocks: &TwitchBlockSet, user_id: &str, login: &str) -> bool {
    blocks.is_blocked(
        (!user_id.is_empty()).then_some(user_id),
        (!login.trim().is_empty()).then_some(login.trim()),
    )
}

fn validate_target_user_id(raw: &str) -> Result<String, String> {
    let id = raw.trim();
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_digit()) {
        return Err("invalid user id".into());
    }
    Ok(id.to_string())
}

fn validate_target_login(raw: &str) -> Result<String, String> {
    let login = raw.trim().to_ascii_lowercase();
    if login.is_empty()
        || login.len() > 25
        || !login.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
    {
        return Err("invalid login".into());
    }
    Ok(login)
}

pub async fn set_user_blocked(
    shared: &Shared,
    target_user_id: &str,
    target_login: &str,
    blocked: bool,
) -> Result<(), String> {
    let target_id = validate_target_user_id(target_user_id)?;
    let target_login = validate_target_login(target_login)?;
    if let Some(self_id) = auth::resolved_twitch_user_id(shared) {
        if self_id == target_id {
            return Err("cannot block yourself".into());
        }
    }
    let Some(token) = auth::oauth_token(shared) else {
        return Err("not logged in".into());
    };
    let client_id = auth::resolved_client_id(shared);
    let client = http_client();
    if blocked {
        put_block(&client, &client_id, &token, &target_id).await?;
    } else {
        delete_block(&client, &client_id, &token, &target_id).await?;
    }
    if let Ok(mut guard) = shared.twitch_blocks.lock() {
        if blocked {
            guard.insert_user(&target_id, &target_login);
        } else {
            guard.remove_user(&target_id, &target_login);
        }
    }
    Ok(())
}

pub fn parse_blocks_page(value: &Value) -> TwitchBlockSet {
    let mut out = TwitchBlockSet::default();
    let Some(arr) = value.get("data").and_then(Value::as_array) else {
        return out;
    };
    for item in arr {
        let Some(obj) = item.as_object() else {
            continue;
        };
        if let Some(id) = obj
            .get("user_id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit()))
        {
            out.user_ids.insert(id.to_string());
        }
        if let Some(login) = obj
            .get("user_login")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            out.logins.insert(login.to_ascii_lowercase());
        }
    }
    out
}

fn pagination_cursor(value: &Value) -> Option<String> {
    value
        .get("pagination")
        .and_then(|p| p.get("cursor"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

pub fn clear_blocks(shared: &Shared) {
    if let Ok(mut slot) = shared.twitch_blocks.lock() {
        slot.clear();
    }
}

pub async fn load(
    slot: &Arc<Mutex<TwitchBlockSet>>,
    user_id: &str,
    token: &str,
    client_id: &str,
) -> bool {
    if let Ok(mut guard) = slot.lock() {
        guard.clear();
    }
    let Some(parsed) = fetch_all_blocks(user_id, token, client_id).await else {
        return false;
    };
    if let Ok(mut guard) = slot.lock() {
        guard.replace(parsed);
    }
    true
}

/// Load Helix blocks for Settings UI and filter gate. Filtering still respects
/// `ignore.enableTwitchBlockedUsers`; cache is kept when the knob is off so the
/// Ignores → Users list matches stock (account blocks independent of checkbox).
pub fn spawn_load(shared: &Shared) {
    let shared = shared.clone();
    tauri::async_runtime::spawn(async move {
        let mut delay = Duration::from_secs(2);
        loop {
            let Some(user_id) = auth::ensure_twitch_user_id(&shared).await else {
                clear_blocks(&shared);
                return;
            };
            let Some(token) = auth::oauth_token(&shared) else {
                clear_blocks(&shared);
                return;
            };
            let client_id = auth::resolved_client_id(&shared);
            if load(&shared.twitch_blocks, &user_id, &token, &client_id).await {
                return;
            }
            tokio::time::sleep(delay).await;
            delay = delay.saturating_mul(2).min(Duration::from_secs(120));
        }
    });
}

pub fn spawn_load_if_enabled(shared: &Shared) {
    spawn_load(shared);
}

pub fn twitch_blocks_enabled(shared: &Shared) -> bool {
    shared
        .settings
        .lock()
        .ok()
        .and_then(|inner| {
            inner
                .data
                .knobs
                .get("ignore.enableTwitchBlockedUsers")
                .and_then(|v| v.as_bool())
        })
        .unwrap_or(true)
}

async fn fetch_all_blocks(user_id: &str, token: &str, client_id: &str) -> Option<TwitchBlockSet> {
    let client = http_client();
    let mut out = TwitchBlockSet::default();
    let mut cursor: Option<String> = None;
    loop {
        let url = blocks_url(user_id, cursor.as_deref())?;
        let value = get_json(&client, &url, client_id, token).await?;
        let page = parse_blocks_page(&value);
        out.merge_page(&page);
        if out.user_ids.len() >= BLOCK_LIMIT {
            break;
        }
        cursor = pagination_cursor(&value);
        if cursor.is_none() {
            break;
        }
    }
    Some(out)
}

fn block_target_url(target_user_id: &str) -> Option<String> {
    let mut url = Url::parse(&format!("{HELIX}/users/blocks")).ok()?;
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("target_user_id", target_user_id);
    }
    Some(url.to_string())
}

fn blocks_url(user_id: &str, cursor: Option<&str>) -> Option<String> {
    let mut url = Url::parse(&format!("{HELIX}/users/blocks")).ok()?;
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("broadcaster_id", user_id);
        q.append_pair("first", "100");
        if let Some(c) = cursor {
            q.append_pair("after", c);
        }
    }
    Some(url.to_string())
}

fn http_client() -> reqwest::Client {
    super::http_client::build(Duration::from_secs(12))
}

async fn get_json(
    client: &reqwest::Client,
    url: &str,
    client_id: &str,
    token: &str,
) -> Option<Value> {
    let mut delay = Duration::from_millis(200);
    for attempt in 0..ATTEMPTS {
        match client
            .get(url)
            .header("Client-Id", client_id)
            .header("Authorization", format!("Bearer {token}"))
            .header("Accept", "application/json")
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => {
                if let Ok(v) = resp.json::<Value>().await {
                    return Some(v);
                }
            }
            Ok(resp) if resp.status().as_u16() == 401 || resp.status().as_u16() == 403 => {
                return None;
            }
            Ok(_) | Err(_) => {}
        }
        if attempt + 1 < ATTEMPTS {
            tokio::time::sleep(delay).await;
            delay = delay.saturating_mul(2);
        }
    }
    None
}

async fn put_block(
    client: &reqwest::Client,
    client_id: &str,
    token: &str,
    target_user_id: &str,
) -> Result<(), String> {
    let url = block_target_url(target_user_id).ok_or_else(|| "block url".to_string())?;
    mutate_block(client, reqwest::Method::PUT, &url, client_id, token).await
}

async fn delete_block(
    client: &reqwest::Client,
    client_id: &str,
    token: &str,
    target_user_id: &str,
) -> Result<(), String> {
    let url = block_target_url(target_user_id).ok_or_else(|| "block url".to_string())?;
    mutate_block(client, reqwest::Method::DELETE, &url, client_id, token).await
}

async fn mutate_block(
    client: &reqwest::Client,
    method: reqwest::Method,
    url: &str,
    client_id: &str,
    token: &str,
) -> Result<(), String> {
    let mut delay = Duration::from_millis(200);
    for attempt in 0..ATTEMPTS {
        match client
            .request(method.clone(), url)
            .header("Client-Id", client_id)
            .header("Authorization", format!("Bearer {token}"))
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => return Ok(()),
            Ok(resp) if resp.status().as_u16() == 401 => {
                return Err("authorization failed; sign in again".into());
            }
            Ok(resp) if resp.status().as_u16() == 403 => {
                return Err("missing block permission; sign in again".into());
            }
            Ok(resp) => {
                if attempt + 1 >= ATTEMPTS {
                    return Err(format!("Helix block failed ({})", resp.status()));
                }
            }
            Err(e) if attempt + 1 >= ATTEMPTS => return Err(e.to_string()),
            Err(_) => {}
        }
        if attempt + 1 < ATTEMPTS {
            tokio::time::sleep(delay).await;
            delay = delay.saturating_mul(2);
        }
    }
    Err("Helix block request failed".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_blocks_page_builds_sets() {
        let value = serde_json::json!({
            "data": [
                { "user_id": "123", "user_login": "Foo" },
                { "user_id": "456", "user_login": "bar" }
            ],
            "pagination": { "cursor": "abc" }
        });
        let set = parse_blocks_page(&value);
        assert!(set.user_ids.contains("123"));
        assert!(set.user_ids.contains("456"));
        assert!(set.logins.contains("foo"));
        assert!(set.logins.contains("bar"));
        assert_eq!(pagination_cursor(&value).as_deref(), Some("abc"));
    }

    #[test]
    fn is_blocked_matches_id_or_login_case_insensitive() {
        let mut set = TwitchBlockSet::default();
        set.user_ids.insert("99".into());
        set.logins.insert("blockeduser".into());
        assert!(set.is_blocked(Some("99"), None));
        assert!(set.is_blocked(None, Some("BlockedUser")));
        assert!(!set.is_blocked(Some("1"), Some("other")));
    }

    #[test]
    fn list_logins_sorted_case_insensitive() {
        let mut set = TwitchBlockSet::default();
        set.logins.insert("zeta".into());
        set.logins.insert("alpha".into());
        set.logins.insert("beta".into());
        assert_eq!(set.list_logins(), vec!["alpha", "beta", "zeta"]);
    }

    #[test]
    fn insert_and_remove_user_updates_sets() {
        let mut set = TwitchBlockSet::default();
        set.insert_user("123", "Foo");
        assert!(set.is_blocked(Some("123"), Some("foo")));
        set.remove_user("123", "Foo");
        assert!(!set.is_blocked(Some("123"), Some("foo")));
    }

    #[test]
    fn is_user_blocked_helper() {
        let mut set = TwitchBlockSet::default();
        set.insert_user("99", "blocked");
        assert!(is_user_blocked(&set, "99", "blocked"));
        assert!(is_user_blocked(&set, "", "blocked"));
        assert!(!is_user_blocked(&set, "1", "other"));
    }

    #[test]
    fn should_drop_blocked_user_respects_show_modes() {
        let mut blocks = TwitchBlockSet::default();
        blocks.user_ids.insert("42".into());
        let viewer = ViewerRole {
            is_mod: false,
            is_broadcaster: false,
        };
        assert!(should_drop_blocked_user(
            &blocks,
            true,
            BlockedUserShow::Never,
            viewer,
            Some("42"),
            Some("foo"),
            Some("me"),
        ));
        assert!(!should_drop_blocked_user(
            &blocks,
            true,
            BlockedUserShow::IfModerator,
            ViewerRole {
                is_mod: true,
                is_broadcaster: false,
            },
            Some("42"),
            Some("foo"),
            Some("me"),
        ));
        assert!(should_drop_blocked_user(
            &blocks,
            true,
            BlockedUserShow::IfModerator,
            viewer,
            Some("42"),
            Some("foo"),
            Some("me"),
        ));
        assert!(!should_drop_blocked_user(
            &blocks,
            true,
            BlockedUserShow::IfBroadcaster,
            ViewerRole {
                is_mod: false,
                is_broadcaster: true,
            },
            Some("42"),
            Some("foo"),
            Some("me"),
        ));
        assert!(!should_drop_blocked_user(
            &blocks,
            false,
            BlockedUserShow::Never,
            viewer,
            Some("42"),
            Some("foo"),
            Some("me"),
        ));
        assert!(!should_drop_blocked_user(
            &blocks,
            true,
            BlockedUserShow::Never,
            viewer,
            Some("42"),
            Some("me"),
            Some("me"),
        ));
    }
}

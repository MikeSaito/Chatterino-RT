//! BTTV / 7TV presence activity after outbound chat (Chatterino TwitchChannel parity). MIT reimpl.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::auth;
use super::fetch::{safe_object_id, EmoteProviderFlags};
use super::state::{BttvCmd, Shared};

const BTTV_ACTIVITY_GAP: Duration = Duration::from_secs(60);
const SEVENTV_ACTIVITY_PESSIMISTIC: Duration = Duration::from_secs(300);
const SEVENTV_ACTIVITY_SUCCESS: Duration = Duration::from_secs(60);
const HTTP_ATTEMPTS: u32 = 3;

pub fn post_send_activity(shared: Shared, channel: String) {
    tauri::async_runtime::spawn(async move {
        run_post_send_activity(&shared, &channel).await;
    });
}

pub fn clear_identity_cache(shared: &Shared) {
    if let Ok(mut act) = shared.activity.lock() {
        act.seventv_user_id = None;
        act.seventv_user_for = None;
        act.bttv_next.clear();
        act.seventv_next.clear();
    }
}

async fn run_post_send_activity(shared: &Shared, channel: &str) {
    if auth::resolved_login_token(shared).is_none() {
        return;
    }
    let twitch_user_id = match auth::ensure_twitch_user_id(shared).await {
        Some(id) => id,
        None => return,
    };
    let room_id = resolve_room_id(shared, channel);
    let Some(room_id) = room_id else {
        return;
    };
    maybe_bttv_activity(shared, channel, &room_id, &twitch_user_id);
    maybe_seventv_activity(shared, channel, &room_id, &twitch_user_id).await;
}

fn resolve_room_id(shared: &Shared, channel: &str) -> Option<String> {
    shared
        .hub
        .lock()
        .ok()
        .and_then(|h| h.room_id(channel).map(str::to_string))
        .or_else(|| {
            shared
                .snapshot_bttv_wanted()
                .channel
                .filter(|c| c.login == channel)
                .map(|c| c.room_id)
        })
}

fn knob_bool(shared: &Shared, key: &str, default: bool) -> bool {
    shared
        .settings
        .lock()
        .ok()
        .and_then(|inner| inner.data.knobs.get(key).and_then(Value::as_bool))
        .unwrap_or(default)
}

fn maybe_bttv_activity(shared: &Shared, channel: &str, room_id: &str, twitch_user_id: &str) {
    if !knob_bool(shared, "emotes.sendBTTVActivity", true) {
        return;
    }
    if !knob_bool(shared, "emotes.enableBTTVLiveUpdates", true) {
        return;
    }
    let wanted = shared.snapshot_bttv_wanted();
    if !wanted.enabled {
        return;
    }
    let now = Instant::now();
    {
        let Ok(mut act) = shared.activity.lock() else {
            return;
        };
        if !rate_limit_allow(&mut act.bttv_next, channel, now, BTTV_ACTIVITY_GAP) {
            return;
        }
    }
    shared.notify_bttv(BttvCmd::BroadcastMe {
        room_id: room_id.to_string(),
        twitch_user_id: twitch_user_id.to_string(),
    });
}

async fn maybe_seventv_activity(
    shared: &Shared,
    channel: &str,
    room_id: &str,
    twitch_user_id: &str,
) {
    let flags = EmoteProviderFlags::from_shared(shared);
    if !knob_bool(shared, "emotes.sendSevenTVActivity", true) {
        return;
    }
    if !flags.seventv_event_api {
        return;
    }
    let seventv_user_id = match ensure_seventv_user_id(shared, twitch_user_id).await {
        Some(id) => id,
        None => return,
    };
    let now = Instant::now();
    {
        let Ok(mut act) = shared.activity.lock() else {
            return;
        };
        if !rate_limit_allow(
            &mut act.seventv_next,
            channel,
            now,
            SEVENTV_ACTIVITY_PESSIMISTIC,
        ) {
            return;
        }
    }
    let ok = post_seventv_presence(&seventv_user_id, room_id).await;
    if let Ok(mut act) = shared.activity.lock() {
        let gap = if ok {
            SEVENTV_ACTIVITY_SUCCESS
        } else {
            SEVENTV_ACTIVITY_PESSIMISTIC
        };
        act.seventv_next
            .insert(channel.to_string(), Instant::now() + gap);
    }
}

async fn ensure_seventv_user_id(shared: &Shared, twitch_user_id: &str) -> Option<String> {
    {
        let Ok(act) = shared.activity.lock() else {
            return None;
        };
        if act.seventv_user_for.as_deref() == Some(twitch_user_id) {
            if let Some(id) = act.seventv_user_id.as_deref() {
                if !id.is_empty() {
                    return Some(id.to_string());
                }
            }
        }
    }
    let url = format!("https://7tv.io/v3/users/twitch/{twitch_user_id}");
    let client = http_client();
    let v = get_json(&client, &url).await.ok()?;
    let id = v
        .get("user")
        .and_then(|u| u.get("id"))
        .and_then(Value::as_str)
        .filter(|s| safe_object_id(s))
        .map(str::to_string)?;
    if let Ok(mut act) = shared.activity.lock() {
        act.seventv_user_for = Some(twitch_user_id.to_string());
        act.seventv_user_id = Some(id.clone());
    }
    Some(id)
}

async fn post_seventv_presence(seventv_user_id: &str, twitch_channel_id: &str) -> bool {
    let url = format!("https://7tv.io/v3/users/{seventv_user_id}/presences");
    let body = json!({
        "kind": 1,
        "data": {
            "id": twitch_channel_id,
            "platform": "TWITCH"
        }
    });
    let client = http_client();
    match client
        .post(&url)
        .header("Accept", "application/json")
        .header("Content-Type", "application/json")
        .json(&body)
        .timeout(Duration::from_secs(10))
        .send()
        .await
    {
        Ok(resp) => resp.status().is_success(),
        Err(_) => false,
    }
}

fn rate_limit_allow(
    map: &mut HashMap<String, Instant>,
    key: &str,
    now: Instant,
    gap: Duration,
) -> bool {
    if map.get(key).is_some_and(|until| now < *until) {
        return false;
    }
    map.insert(key.to_string(), now + gap);
    true
}

pub fn broadcast_me_payload(room_id: &str, twitch_user_id: &str) -> Value {
    json!({
        "name": "broadcast_me",
        "data": {
            "provider": "twitch",
            "providerId": twitch_user_id,
            "channel": format!("twitch:{room_id}")
        }
    })
}

async fn get_json(client: &reqwest::Client, url: &str) -> Result<Value, ()> {
    let mut delay = Duration::from_millis(200);
    for attempt in 0..HTTP_ATTEMPTS {
        match client
            .get(url)
            .header("Accept", "application/json")
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => {
                if let Ok(v) = resp.json::<Value>().await {
                    return Ok(v);
                }
            }
            Ok(_) | Err(_) => {}
        }
        if attempt + 1 < HTTP_ATTEMPTS {
            tokio::time::sleep(delay).await;
            delay *= 2;
        }
    }
    Err(())
}

fn http_client() -> reqwest::Client {
    super::http_client::build(Duration::from_secs(12))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn broadcast_me_payload_shape() {
        let v = broadcast_me_payload("123", "42");
        assert_eq!(v.get("name").and_then(Value::as_str), Some("broadcast_me"));
        let data = v.get("data").expect("data");
        assert_eq!(data.get("provider").and_then(Value::as_str), Some("twitch"));
        assert_eq!(data.get("providerId").and_then(Value::as_str), Some("42"));
        assert_eq!(
            data.get("channel").and_then(Value::as_str),
            Some("twitch:123")
        );
    }

    #[test]
    fn rate_limit_blocks_until_gap() {
        let mut map = HashMap::new();
        let t0 = Instant::now();
        assert!(rate_limit_allow(
            &mut map,
            "xqc",
            t0,
            Duration::from_secs(60)
        ));
        assert!(!rate_limit_allow(
            &mut map,
            "xqc",
            t0 + Duration::from_secs(30),
            Duration::from_secs(60)
        ));
        assert!(rate_limit_allow(
            &mut map,
            "xqc",
            t0 + Duration::from_secs(61),
            Duration::from_secs(60)
        ));
    }

    #[test]
    fn seventv_user_id_from_nested_user() {
        let v = json!({
            "id": "44317909",
            "user": { "id": "01G19JH52G0009BYRM03QJZ6X4" }
        });
        let id = v
            .get("user")
            .and_then(|u| u.get("id"))
            .and_then(Value::as_str)
            .filter(|s| safe_object_id(s))
            .map(str::to_string);
        assert_eq!(id.as_deref(), Some("01G19JH52G0009BYRM03QJZ6X4"));
    }

    #[test]
    fn resolve_room_id_prefers_hub() {
        let shared = Shared::new();
        shared.hub.lock().unwrap().set_room_id("xqc", "99".into());
        assert_eq!(resolve_room_id(&shared, "xqc").as_deref(), Some("99"));
    }

    #[test]
    fn bttv_activity_respects_send_knob() {
        let shared = Shared::new();
        shared.hub.lock().unwrap().set_active(Some("xqc".into()));
        shared.notify_bttv(super::super::state::BttvCmd::SetChannel {
            login: "xqc".into(),
            room_id: "1".into(),
        });
        {
            let mut settings = shared.settings.lock().unwrap();
            settings
                .data
                .knobs
                .insert("emotes.sendBTTVActivity".into(), Value::Bool(false));
        }
        maybe_bttv_activity(&shared, "xqc", "1", "42");
        assert!(shared.bttv_tx.lock().unwrap().is_none());
    }
}

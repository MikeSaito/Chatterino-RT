use std::collections::BTreeMap;
use std::time::Duration;

use serde_json::Value;
use url::Url;

use super::cheers::CheerCatalog;
use super::emotes::{Catalog, EmoteDef, SetScope};
use super::helix::BadgeCatalog;
use super::hub::Hub;
use super::state::Shared;

const ATTEMPTS: u32 = 3;

/// Show-provider knobs (defaults match Settings catalog / Chatterino).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EmoteProviderFlags {
    pub bttv_global: bool,
    pub bttv_channel: bool,
    pub ffz_global: bool,
    pub ffz_channel: bool,
    pub seventv_global: bool,
    pub seventv_channel: bool,
    pub show_unlisted_7tv: bool,
    pub seventv_event_api: bool,
}

impl Default for EmoteProviderFlags {
    fn default() -> Self {
        Self {
            bttv_global: true,
            bttv_channel: true,
            ffz_global: true,
            ffz_channel: true,
            seventv_global: true,
            seventv_channel: true,
            show_unlisted_7tv: false,
            seventv_event_api: true,
        }
    }
}

impl EmoteProviderFlags {
    pub fn from_knobs(knobs: &BTreeMap<String, Value>) -> Self {
        Self {
            bttv_global: knob_bool(knobs, "emotes.enableBTTVGlobalEmotes", true),
            bttv_channel: knob_bool(knobs, "emotes.enableBTTVChannelEmotes", true),
            ffz_global: knob_bool(knobs, "emotes.enableFFZGlobalEmotes", true),
            ffz_channel: knob_bool(knobs, "emotes.enableFFZChannelEmotes", true),
            seventv_global: knob_bool(knobs, "emotes.enableSevenTVGlobalEmotes", true),
            seventv_channel: knob_bool(knobs, "emotes.enableSevenTVChannelEmotes", true),
            show_unlisted_7tv: knob_bool(knobs, "emotes.showUnlistedSevenTVEmotes", false),
            seventv_event_api: knob_bool(knobs, "emotes.enableSevenTVEventAPI", true),
        }
    }

    pub fn from_shared(shared: &Shared) -> Self {
        shared
            .settings
            .lock()
            .ok()
            .map(|inner| Self::from_knobs(&inner.data.knobs))
            .unwrap_or_default()
    }

    /// Knobs that require Catalog HTTP reload (not EventAPI enable alone).
    pub fn catalog_reload_key(self) -> (bool, bool, bool, bool, bool, bool, bool) {
        (
            self.bttv_global,
            self.bttv_channel,
            self.ffz_global,
            self.ffz_channel,
            self.seventv_global,
            self.seventv_channel,
            self.show_unlisted_7tv,
        )
    }
}

fn knob_bool(knobs: &BTreeMap<String, Value>, key: &str, default: bool) -> bool {
    knobs
        .get(key)
        .and_then(Value::as_bool)
        .unwrap_or(default)
}

pub async fn load_globals(
    catalog: &std::sync::Arc<std::sync::Mutex<Catalog>>,
    flags: EmoteProviderFlags,
) -> Result<Option<String>, ()> {
    let gen = {
        let Ok(mut cat) = catalog.lock() else {
            return Err(());
        };
        cat.bump_global_load()
    };
    let client = http_client();
    let mut map = std::collections::HashMap::new();
    if flags.bttv_global {
        if let Ok(list) = get_json(&client, "https://api.betterttv.net/3/cached/emotes/global").await
        {
            collect_bttv(&list, &mut map);
        }
    }
    if flags.ffz_global {
        if let Ok(v) = get_json(&client, "https://api.frankerfacez.com/v1/set/global").await {
            collect_ffz_sets(&v, &mut map);
        }
    }
    let mut global_set_id = None;
    if flags.seventv_global {
        if let Ok(v) = get_json(&client, "https://7tv.io/v3/emote-sets/global").await {
            global_set_id = object_id(v.get("id"));
            collect_7tv_set(&v, &mut map, flags.show_unlisted_7tv);
        }
    }
    let Ok(mut cat) = catalog.lock() else {
        return Err(());
    };
    if cat.global_load_gen() != gen {
        return Err(());
    }
    cat.purge_global("bttv");
    cat.purge_global("ffz");
    cat.purge_global("7tv");
    for (k, v) in map {
        cat.insert_global(k, v);
    }
    if let Some(id) = global_set_id.as_ref() {
        cat.bind_set(id.clone(), SetScope::Global);
    }
    Ok(global_set_id)
}

pub async fn load_channel(
    catalog: &std::sync::Arc<std::sync::Mutex<Catalog>>,
    badges: &std::sync::Arc<std::sync::Mutex<BadgeCatalog>>,
    cheers: &std::sync::Arc<std::sync::Mutex<CheerCatalog>>,
    hub: &std::sync::Arc<std::sync::Mutex<Hub>>,
    login: &str,
    room_id: &str,
    token: Option<&str>,
    client_id: &str,
    flags: EmoteProviderFlags,
) -> Option<(String, String)> {
    let gen = {
        let Ok(h) = hub.lock() else {
            return None;
        };
        if h.active.as_deref() != Some(login) {
            return None;
        }
        let Ok(mut cat) = catalog.lock() else {
            return None;
        };
        cat.bump_load()
    };
    let client = http_client();
    let mut map = std::collections::HashMap::new();
    if flags.bttv_channel {
        let bttv_url = format!("https://api.betterttv.net/3/cached/users/twitch/{room_id}");
        if let Ok(v) = get_json(&client, &bttv_url).await {
            if let Some(arr) = v.get("channelEmotes") {
                collect_bttv(arr, &mut map);
            }
            if let Some(arr) = v.get("sharedEmotes") {
                collect_bttv(arr, &mut map);
            }
        }
    }
    if flags.ffz_channel {
        let ffz_url = format!("https://api.frankerfacez.com/v1/room/{login}");
        if let Ok(v) = get_json(&client, &ffz_url).await {
            collect_ffz_sets(&v, &mut map);
        }
    }
    let mut seventv = None;
    if flags.seventv_channel {
        let stv_url = format!("https://7tv.io/v3/users/twitch/{room_id}");
        if let Ok(v) = get_json(&client, &stv_url).await {
            let user_id = object_id(v.get("id"));
            if let Some(set) = v.get("emote_set") {
                let set_id = object_id(set.get("id"));
                collect_7tv_set(set, &mut map, flags.show_unlisted_7tv);
                if let (Some(set_id), Some(user_id)) = (set_id, user_id) {
                    seventv = Some((set_id, user_id));
                }
            }
        }
    }
    let mut applied = false;
    super::helix::commit_if_active(hub, login, catalog, |cat| {
        if cat.load_gen() != gen {
            return;
        }
        cat.replace_channel_third_party(login, map);
        if let Some((set_id, _)) = seventv.as_ref() {
            cat.bind_set(set_id.clone(), SetScope::Channel(login.to_string()));
        } else {
            cat.purge_channel(login, "7tv");
        }
        applied = true;
    });
    if !applied {
        return None;
    }
    super::helix::load_channel(
        badges, cheers, catalog, hub, login, room_id, token, client_id, gen,
    )
    .await;
    let still_active = hub
        .lock()
        .ok()
        .and_then(|h| h.active.clone())
        .is_some_and(|ch| ch == login);
    if !still_active {
        return None;
    }
    seventv
}

pub async fn load_7tv_set(
    set_id: &str,
    show_unlisted: bool,
) -> Option<std::collections::HashMap<String, EmoteDef>> {
    if !safe_object_id(set_id) {
        return None;
    }
    let client = http_client();
    let url = format!("https://7tv.io/v3/emote-sets/{set_id}");
    let v = get_json(&client, &url).await.ok()?;
    let mut map = std::collections::HashMap::new();
    collect_7tv_set(&v, &mut map, show_unlisted);
    Some(map)
}

fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .user_agent("Chatterino-RT/0.1")
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

async fn get_json(client: &reqwest::Client, url: &str) -> Result<Value, ()> {
    let mut delay = Duration::from_millis(200);
    let mut last = String::from("no response");
    for attempt in 0..ATTEMPTS {
        match client.get(url).send().await {
            Ok(resp) => {
                let status = resp.status();
                if status.is_success() {
                    match resp.json::<Value>().await {
                        Ok(v) => return Ok(v),
                        Err(e) => last = format!("json: {e}"),
                    }
                } else {
                    last = format!("http {status}");
                }
            }
            Err(e) => last = e.to_string(),
        }
        if attempt + 1 < ATTEMPTS {
            tokio::time::sleep(delay).await;
            delay *= 2;
        }
    }
    eprintln!("emote fetch failed after {ATTEMPTS} attempts ({last}): {url}");
    Err(())
}

fn collect_bttv(value: &Value, map: &mut std::collections::HashMap<String, EmoteDef>) {
    let arr = match value {
        Value::Array(a) => a.as_slice(),
        _ => return,
    };
    for item in arr {
        let id = item.get("id").and_then(Value::as_str).unwrap_or("");
        let code = item.get("code").and_then(Value::as_str).unwrap_or("");
        if !safe_object_id(id) || code.is_empty() || code.len() > 100 {
            continue;
        }
        map.insert(
            code.to_string(),
            EmoteDef {
                id: id.to_string(),
                provider: "bttv".into(),
                url: format!("https://cdn.betterttv.net/emote/{id}/1x"),
                zero_width: false,
            },
        );
    }
}

fn collect_ffz_sets(value: &Value, map: &mut std::collections::HashMap<String, EmoteDef>) {
    let sets = value.get("sets").and_then(Value::as_object);
    let Some(sets) = sets else { return };
    for set in sets.values() {
        let Some(emotes) = set.get("emoticons").and_then(Value::as_array) else {
            continue;
        };
        for item in emotes {
            let id = item.get("id").map(|v| v.to_string()).unwrap_or_default();
            let code = item.get("name").and_then(Value::as_str).unwrap_or("");
            if id.is_empty() || id.len() > 32 || code.is_empty() || code.len() > 100 {
                continue;
            }
            if !id.chars().all(|c| c.is_ascii_digit()) {
                continue;
            }
            let Some(url) = item
                .get("urls")
                .and_then(Value::as_object)
                .and_then(|u| u.get("1").or_else(|| u.get("2")).or_else(|| u.get("4")))
                .and_then(Value::as_str)
                .and_then(allowed_ffz_url)
            else {
                continue;
            };
            map.insert(
                code.to_string(),
                EmoteDef {
                    id,
                    provider: "ffz".into(),
                    url,
                    zero_width: false,
                },
            );
        }
    }
}

fn collect_7tv_set(
    value: &Value,
    map: &mut std::collections::HashMap<String, EmoteDef>,
    show_unlisted: bool,
) {
    let emotes = value.get("emotes").and_then(Value::as_array);
    let Some(emotes) = emotes else { return };
    for item in emotes {
        if let Some((name, def)) = parse_active_emote(item, show_unlisted) {
            map.insert(name, def);
        }
    }
}

pub(crate) fn parse_active_emote(item: &Value, show_unlisted: bool) -> Option<(String, EmoteDef)> {
    let name = item.get("name").and_then(Value::as_str).unwrap_or("");
    if name.is_empty() || name.len() > 100 {
        return None;
    }
    let data = item.get("data")?;
    let listed = data
        .get("listed")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    if !listed && !show_unlisted {
        return None;
    }
    let id = data.get("id").and_then(Value::as_str).unwrap_or("");
    if !safe_object_id(id) {
        return None;
    }
    let host = data
        .get("host")
        .and_then(|h| h.get("url"))
        .and_then(Value::as_str)
        .unwrap_or("");
    if host.is_empty() {
        return None;
    }
    let file = data
        .get("host")
        .and_then(|h| h.get("files"))
        .and_then(Value::as_array)
        .and_then(|files| {
            files.iter().find_map(|f| {
                let n = f.get("name").and_then(Value::as_str)?;
                if safe_7tv_file(n) {
                    Some(n)
                } else {
                    None
                }
            })
        })
        .unwrap_or("1x.webp");
    if !safe_7tv_file(file) {
        return None;
    }
    let url = seventv_cdn_url(host, file)?;
    Some((
        name.to_string(),
        EmoteDef {
            id: id.to_string(),
            provider: "7tv".into(),
            url,
            zero_width: is_7tv_zero_width(item),
        },
    ))
}

fn object_id(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|s| safe_object_id(s))
        .map(str::to_string)
}

pub(crate) fn safe_object_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric())
}

fn safe_7tv_file(name: &str) -> bool {
    name.starts_with("1x")
        && name.len() <= 32
        && !name.contains("..")
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_')
}

fn seventv_cdn_url(host: &str, file: &str) -> Option<String> {
    let composed = format!("{}/{file}", abs_url(host));
    let parsed = Url::parse(&composed).ok()?;
    if parsed.scheme() != "https" {
        return None;
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return None;
    }
    if parsed.host_str() != Some("cdn.7tv.app") {
        return None;
    }
    Some(parsed.as_str().to_string())
}

// 7TV ActiveEmote flags: ZeroWidth = 1 << 0 (Chatterino SeventvEmotes.cpp).
const SEVENTV_ACTIVE_ZERO_WIDTH: u64 = 1;

fn is_7tv_zero_width(item: &Value) -> bool {
    item.get("flags")
        .and_then(|v| v.as_u64().or_else(|| v.as_i64().and_then(|n| u64::try_from(n).ok())))
        .is_some_and(|flags| flags & SEVENTV_ACTIVE_ZERO_WIDTH != 0)
}

fn abs_url(raw: &str) -> String {
    if raw.starts_with("//") {
        format!("https:{raw}")
    } else if raw.starts_with("http://") || raw.starts_with("https://") {
        raw.to_string()
    } else {
        format!("https://{raw}")
    }
}

pub(crate) fn allowed_ffz_url(raw: &str) -> Option<String> {
    let composed = abs_url(raw);
    let parsed = Url::parse(&composed).ok()?;
    if parsed.scheme() != "https" {
        return None;
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return None;
    }
    match parsed.host_str() {
        Some("cdn.frankerfacez.com") | Some("cdn.frankerfacez.net") => {
            Some(parsed.as_str().to_string())
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_7tv(flags: u64) -> Value {
        serde_json::json!({
            "emotes": [{
                "id": "abc",
                "name": "cvHazmat",
                "flags": flags,
                "data": {
                    "id": "abc",
                    "host": {
                        "url": "//cdn.7tv.app/emote/abc",
                        "files": [{"name": "1x.webp"}]
                    }
                }
            }]
        })
    }

    #[test]
    fn seventv_flags_bit0_is_zero_width() {
        let mut map = std::collections::HashMap::new();
        collect_7tv_set(&sample_7tv(1), &mut map, false);
        let def = map.get("cvHazmat").expect("emote");
        assert!(def.zero_width);
        assert_eq!(def.provider, "7tv");
    }

    #[test]
    fn seventv_flags_unset_is_not_zero_width() {
        let mut map = std::collections::HashMap::new();
        collect_7tv_set(&sample_7tv(0), &mut map, false);
        assert!(!map.get("cvHazmat").expect("emote").zero_width);
    }

    #[test]
    fn ffz_rejects_foreign_host() {
        let evil = serde_json::json!({
            "sets": {
                "1": {
                    "emoticons": [{
                        "id": 42,
                        "name": "Kappa",
                        "urls": { "1": "https://evil.example/x.png" }
                    }]
                }
            }
        });
        let mut map = std::collections::HashMap::new();
        collect_ffz_sets(&evil, &mut map);
        assert!(map.is_empty());
        let ok = serde_json::json!({
            "sets": {
                "1": {
                    "emoticons": [{
                        "id": 42,
                        "name": "Kappa",
                        "urls": { "1": "//cdn.frankerfacez.com/emote/42/1" }
                    }]
                }
            }
        });
        collect_ffz_sets(&ok, &mut map);
        assert_eq!(
            map.get("Kappa").map(|d| d.url.as_str()),
            Some("https://cdn.frankerfacez.com/emote/42/1")
        );
    }

    #[test]
    fn bttv_rejects_bad_id() {
        let evil = serde_json::json!([{
            "id": "../x",
            "code": "Evil"
        }]);
        let mut map = std::collections::HashMap::new();
        collect_bttv(&evil, &mut map);
        assert!(map.is_empty());
    }

    #[test]
    fn seventv_rejects_foreign_host_and_bad_id() {
        let evil = serde_json::json!({
            "id": "abc",
            "name": "cvHazmat",
            "flags": 0,
            "data": {
                "id": "abc",
                "host": {
                    "url": "https://evil.example/emote/abc",
                    "files": [{"name": "1x.webp"}]
                }
            }
        });
        assert!(parse_active_emote(&evil, false).is_none());
        let js = serde_json::json!({
            "id": "abc",
            "name": "cvHazmat",
            "data": {
                "id": "abc",
                "host": {
                    "url": "javascript:alert(1)",
                    "files": [{"name": "1x.webp"}]
                }
            }
        });
        assert!(parse_active_emote(&js, false).is_none());
        let missing = serde_json::json!({
            "id": "abc",
            "name": "cvHazmat",
            "flags": 0
        });
        assert!(parse_active_emote(&missing, false).is_none());
        let bad_id = serde_json::json!({
            "name": "cvHazmat",
            "data": {
                "id": "../x",
                "host": {
                    "url": "//cdn.7tv.app/emote/abc",
                    "files": [{"name": "1x.webp"}]
                }
            }
        });
        assert!(parse_active_emote(&bad_id, false).is_none());
    }

    #[test]
    fn seventv_unlisted_respects_flag() {
        let item = serde_json::json!({
            "name": "Hidden",
            "flags": 0,
            "data": {
                "id": "abc",
                "listed": false,
                "host": {
                    "url": "//cdn.7tv.app/emote/abc",
                    "files": [{"name": "1x.webp"}]
                }
            }
        });
        assert!(parse_active_emote(&item, false).is_none());
        assert!(parse_active_emote(&item, true).is_some());
    }

    #[test]
    fn provider_flags_defaults_when_knobs_absent() {
        let flags = EmoteProviderFlags::from_knobs(&BTreeMap::new());
        assert!(flags.bttv_global);
        assert!(flags.bttv_channel);
        assert!(flags.ffz_global);
        assert!(flags.ffz_channel);
        assert!(flags.seventv_global);
        assert!(flags.seventv_channel);
        assert!(!flags.show_unlisted_7tv);
        assert!(flags.seventv_event_api);
    }
}

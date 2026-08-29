use std::collections::BTreeMap;
use std::time::Duration;

use serde_json::Value;
use url::Url;

use super::cheers::CheerCatalog;
use super::emotes::{Catalog, EmoteDef, SetScope};
use super::ffz_channel::{parse_ffz_room_extras, FfzChannelExtras};
use super::helix::BadgeCatalog;
use super::hub::Hub;
use super::state::Shared;

const ATTEMPTS: u32 = 3;
const FETCH_LOG_COOLDOWN_MS: u64 = 30_000;

static LAST_EMOTE_FAIL_LOG_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Rate-limit stderr on transport storms (TLS reset / offline).
pub(crate) fn log_http_fail_throttled(
    stamp: &std::sync::atomic::AtomicU64,
    kind: &str,
    detail: &str,
    url: &str,
) {
    use std::sync::atomic::Ordering;
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let prev = stamp.load(Ordering::Relaxed);
    if now.saturating_sub(prev) < FETCH_LOG_COOLDOWN_MS {
        return;
    }
    stamp.store(now, Ordering::Relaxed);
    eprintln!("{kind} fetch failed ({detail}); further noise suppressed ~30s. example: {url}");
}

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
    knobs.get(key).and_then(Value::as_bool).unwrap_or(default)
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
    let bttv_f = flags.bttv_global;
    let ffz_f = flags.ffz_global;
    let stv_f = flags.seventv_global;
    let show_unlisted = flags.show_unlisted_7tv;
    let (bttv_v, ffz_v, stv_v) = tokio::join!(
        async {
            if bttv_f {
                get_json(&client, "https://api.betterttv.net/3/cached/emotes/global")
                    .await
                    .ok()
            } else {
                None
            }
        },
        async {
            if ffz_f {
                get_json(&client, "https://api.frankerfacez.com/v1/set/global")
                    .await
                    .ok()
            } else {
                None
            }
        },
        async {
            if stv_f {
                get_json(&client, "https://7tv.io/v3/emote-sets/global")
                    .await
                    .ok()
            } else {
                None
            }
        },
    );
    let mut map = std::collections::HashMap::new();
    if let Some(list) = bttv_v {
        collect_bttv(&list, &mut map);
    }
    if let Some(v) = ffz_v {
        collect_ffz_sets(&v, &mut map);
    }
    let mut global_set_id = None;
    if let Some(v) = stv_v {
        global_set_id = object_id(v.get("id"));
        collect_7tv_set(&v, &mut map, show_unlisted);
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
    ffz_channel: &std::sync::Arc<
        std::sync::Mutex<std::collections::HashMap<String, FfzChannelExtras>>,
    >,
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
    let bttv_f = flags.bttv_channel;
    let ffz_f = flags.ffz_channel;
    let stv_f = flags.seventv_channel;
    let show_unlisted = flags.show_unlisted_7tv;
    let bttv_url = format!("https://api.betterttv.net/3/cached/users/twitch/{room_id}");
    let ffz_url = format!("https://api.frankerfacez.com/v1/room/{login}");
    let stv_url = format!("https://7tv.io/v3/users/twitch/{room_id}");
    let (bttv_v, ffz_v, stv_v) = tokio::join!(
        async {
            if bttv_f {
                get_json(&client, &bttv_url).await.ok()
            } else {
                None
            }
        },
        async {
            if ffz_f {
                get_json(&client, &ffz_url).await.ok()
            } else {
                None
            }
        },
        async {
            if stv_f {
                get_json(&client, &stv_url).await.ok()
            } else {
                None
            }
        },
    );
    let mut map = std::collections::HashMap::new();
    if let Some(v) = bttv_v {
        if let Some(arr) = v.get("channelEmotes") {
            collect_bttv(arr, &mut map);
        }
        if let Some(arr) = v.get("sharedEmotes") {
            collect_bttv(arr, &mut map);
        }
    }
    let mut ffz_extras = None;
    if let Some(v) = ffz_v {
        collect_ffz_sets(&v, &mut map);
        ffz_extras = Some(parse_ffz_room_extras(&v));
    }
    let mut seventv = None;
    if let Some(v) = stv_v {
        let user_id = object_id(v.get("id"));
        if let Some(set) = v.get("emote_set") {
            let set_id = object_id(set.get("id"));
            collect_7tv_set(set, &mut map, show_unlisted);
            if let (Some(set_id), Some(user_id)) = (set_id, user_id) {
                seventv = Some((set_id, user_id));
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
        if let Ok(mut slot) = ffz_channel.lock() {
            if flags.ffz_channel {
                if let Some(extras) = ffz_extras.take() {
                    slot.insert(login.to_string(), extras);
                }
            } else {
                slot.remove(login);
            }
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

fn cdn_http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .redirect(reqwest::redirect::Policy::none())
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
                } else if status.as_u16() == 404 || status.as_u16() == 410 {
                    // Канал без BTTV/FFZ/7TV — ожидаемо, не спамим stderr.
                    return Err(());
                } else if status.as_u16() == 429 || status.is_server_error() {
                    last = format!("http {status}");
                } else {
                    // Прочие 4xx без ретраев.
                    log_http_fail_throttled(
                        &LAST_EMOTE_FAIL_LOG_MS,
                        "emote",
                        &format!("http {status}"),
                        url,
                    );
                    return Err(());
                }
            }
            Err(e) => last = e.to_string(),
        }
        if attempt + 1 < ATTEMPTS {
            tokio::time::sleep(delay).await;
            delay *= 2;
        }
    }
    log_http_fail_throttled(
        &LAST_EMOTE_FAIL_LOG_MS,
        "emote",
        &format!("after {ATTEMPTS} attempts: {last}"),
        url,
    );
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
                display_width: None,
                display_height: None,
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
                    display_width: None,
                    display_height: None,
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
    let listed = data.get("listed").and_then(Value::as_bool).unwrap_or(true);
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
        .and_then(Value::as_array);
    let file_name = file
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
    if !safe_7tv_file(file_name) {
        return None;
    }
    let (display_width, display_height) = file
        .and_then(|files| seventv_display_size(files, file_name))
        .unwrap_or((None, None));
    let url = seventv_cdn_url(host, file_name)?;
    Some((
        name.to_string(),
        EmoteDef {
            id: id.to_string(),
            provider: "7tv".into(),
            url,
            zero_width: is_7tv_zero_width(item),
            display_width,
            display_height,
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

fn seventv_dim(v: &Value) -> Option<u16> {
    if let Some(n) = v.as_u64() {
        return (n > 0 && n <= u16::MAX as u64).then(|| n as u16);
    }
    v.as_f64()
        .filter(|&n| n.is_finite() && n > 0.0)
        .map(|n| n.round() as u64)
        .filter(|&n| n > 0 && n <= u16::MAX as u64)
        .map(|n| n as u16)
}

fn seventv_file_dims(entry: &Value) -> Option<(u16, u16)> {
    let w = entry.get("width").and_then(seventv_dim)?;
    let h = entry.get("height").and_then(seventv_dim)?;
    Some((w, h))
}

/// Logical 1x display box from the WEBP file we load (Chatterino Image::expectedSize).
fn seventv_display_size(files: &[Value], file_name: &str) -> Option<(Option<u16>, Option<u16>)> {
    let webp = |f: &&Value| f.get("format").and_then(Value::as_str) == Some("WEBP");
    let by_name = |name: &str| {
        files
            .iter()
            .find(|f| f.get("name").and_then(Value::as_str) == Some(name))
    };
    let entry = by_name(file_name)
        .filter(|f| webp(f))
        .or_else(|| by_name("1x.webp").filter(|f| webp(f)))
        .or_else(|| by_name(file_name))?;
    let (w, h) = seventv_file_dims(entry)?;
    Some((Some(w), Some(h)))
}

/// Static WEBP badge URL from 7TV cosmetic `data.host` (Chatterino createImageSet useStatic=true).
pub(crate) fn seventv_badge_url(data: &Value) -> Option<String> {
    let host = data.get("host")?;
    let base = host.get("url").and_then(Value::as_str)?;
    let files = host.get("files")?.as_array()?;
    for file in files {
        if file.get("format").and_then(Value::as_str) != Some("WEBP") {
            continue;
        }
        let name = file
            .get("static_name")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .or_else(|| file.get("name").and_then(Value::as_str))
            .filter(|s| safe_7tv_file(s))?;
        return seventv_cdn_url(base, name);
    }
    None
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
        .and_then(|v| {
            v.as_u64()
                .or_else(|| v.as_i64().and_then(|n| u64::try_from(n).ok()))
        })
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

pub(crate) fn allowed_bttv_url(raw: &str) -> Option<String> {
    let composed = abs_url(raw);
    let parsed = Url::parse(&composed).ok()?;
    if parsed.scheme() != "https" {
        return None;
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return None;
    }
    match parsed.host_str() {
        Some("cdn.betterttv.net") => Some(parsed.as_str().to_string()),
        _ => None,
    }
}

pub(crate) fn allowed_chatterino_badge_url(raw: &str) -> Option<String> {
    let composed = abs_url(raw);
    let mut parsed = Url::parse(&composed).ok()?;
    if parsed.scheme() != "https" {
        return None;
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return None;
    }
    if parsed.host_str() != Some("fourtf.com") {
        return None;
    }
    let path = parsed.path();
    if !path.starts_with("/chatterino/badges/") {
        return None;
    }
    if !path.to_ascii_lowercase().ends_with(".png") {
        return None;
    }
    let file = path.rsplit('/').next().unwrap_or("");
    if file.is_empty() || file.contains("..") {
        return None;
    }
    parsed.set_query(None);
    parsed.set_fragment(None);
    Some(parsed.as_str().to_string())
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

/// Allowlist CDN картинок эмодзи/бейджей для `fetch_emote_cdn` (CORS fallback).
pub fn allowed_emote_cdn_url(raw: &str) -> Option<String> {
    allowed_bttv_url(raw)
        .or_else(|| allowed_ffz_url(raw))
        .or_else(|| allowed_7tv_cdn_url(raw))
        .or_else(|| allowed_chatterino_badge_url(raw))
        .or_else(|| crate::chat::helix::allowed_badge_url(raw))
        .or_else(|| crate::chat::helix::allowed_cheer_url(raw))
        .or_else(|| allowed_jsdelivr_emoji_url(raw))
}

fn allowed_7tv_cdn_url(raw: &str) -> Option<String> {
    let composed = abs_url(raw);
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
    let path = parsed.path();
    if !path.starts_with("/emote/") && !path.starts_with("/badge/") {
        return None;
    }
    Some(parsed.as_str().to_string())
}

fn allowed_jsdelivr_emoji_url(raw: &str) -> Option<String> {
    let composed = abs_url(raw);
    let parsed = Url::parse(&composed).ok()?;
    if parsed.scheme() != "https" {
        return None;
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return None;
    }
    if parsed.host_str() != Some("cdn.jsdelivr.net") {
        return None;
    }
    if !parsed.path().starts_with("/npm/emoji-datasource-") {
        return None;
    }
    Some(parsed.as_str().to_string())
}

pub async fn fetch_cdn_image(url: &str) -> Result<(Vec<u8>, Option<String>), String> {
    let allowed = allowed_emote_cdn_url(url).ok_or_else(|| "url not allowed".to_string())?;
    let client = cdn_http_client();
    let mut delay = Duration::from_millis(200);
    let mut last = String::from("no response");
    for attempt in 0..ATTEMPTS {
        match client.get(&allowed).send().await {
            Ok(resp) => {
                let status = resp.status();
                if status.is_redirection() {
                    last = format!("http {status} (redirects not followed)");
                } else if status == reqwest::StatusCode::OK {
                    let content_type = resp
                        .headers()
                        .get(reqwest::header::CONTENT_TYPE)
                        .and_then(|v| v.to_str().ok())
                        .map(str::to_string);
                    match resp.bytes().await {
                        Ok(bytes) if !bytes.is_empty() => {
                            return Ok((bytes.to_vec(), content_type));
                        }
                        Ok(_) => last = "empty body".to_string(),
                        Err(e) => last = e.to_string(),
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
    Err(last)
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
                        "files": [{"name": "1x.webp", "width": 28, "height": 28}]
                    }
                }
            }]
        })
    }

    fn sample_7tv_wide() -> Value {
        serde_json::json!({
            "emotes": [{
                "id": "wide",
                "name": "wideEmote",
                "flags": 0,
                "data": {
                    "id": "wide",
                    "host": {
                        "url": "//cdn.7tv.app/emote/wide",
                        "files": [{"name": "1x.webp", "width": 56, "height": 28}]
                    }
                }
            }]
        })
    }

    #[test]
    fn seventv_parses_display_size() {
        let mut map = std::collections::HashMap::new();
        collect_7tv_set(&sample_7tv_wide(), &mut map, false);
        let def = map.get("wideEmote").expect("emote");
        assert_eq!(def.display_width, Some(56));
        assert_eq!(def.display_height, Some(28));
    }

    #[test]
    fn seventv_display_size_prefers_webp_over_avif_name() {
        let item = serde_json::json!({
            "name": "mix",
            "data": {
                "id": "mix",
                "host": {
                    "url": "//cdn.7tv.app/emote/mix",
                    "files": [
                        {"name": "1x.avif", "format": "AVIF", "width": 10, "height": 10},
                        {"name": "1x.webp", "format": "WEBP", "width": 56, "height": 28}
                    ]
                }
            }
        });
        let (_, def) = parse_active_emote(&item, false).expect("parsed");
        assert_eq!(def.display_width, Some(56));
        assert_eq!(def.display_height, Some(28));
    }

    #[test]
    fn seventv_display_size_missing_dims_is_none() {
        let item = serde_json::json!({
            "name": "nodim",
            "data": {
                "id": "nodim",
                "host": {
                    "url": "//cdn.7tv.app/emote/nodim",
                    "files": [{"name": "1x.webp", "format": "WEBP"}]
                }
            }
        });
        let (_, def) = parse_active_emote(&item, false).expect("parsed");
        assert_eq!(def.display_width, None);
        assert_eq!(def.display_height, None);
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
    fn emote_cdn_url_allowlist() {
        assert_eq!(
            allowed_emote_cdn_url("https://cdn.betterttv.net/emote/abc/1x"),
            Some("https://cdn.betterttv.net/emote/abc/1x".into())
        );
        assert_eq!(
            allowed_emote_cdn_url("//cdn.7tv.app/emote/abc/1x.webp"),
            Some("https://cdn.7tv.app/emote/abc/1x.webp".into())
        );
        assert_eq!(
            allowed_emote_cdn_url("https://cdn.7tv.app/badge/badge1/1x_static.webp"),
            Some("https://cdn.7tv.app/badge/badge1/1x_static.webp".into())
        );
        assert!(allowed_emote_cdn_url("https://cdn.7tv.app/other/x.webp").is_none());
        assert_eq!(
            allowed_emote_cdn_url(
                "https://cdn.jsdelivr.net/npm/emoji-datasource-twitter@15.1.2/img/twitter/64/1f600.png"
            ),
            Some(
                "https://cdn.jsdelivr.net/npm/emoji-datasource-twitter@15.1.2/img/twitter/64/1f600.png"
                    .into()
            )
        );
        assert!(allowed_emote_cdn_url("https://evil.example/emote/x.png").is_none());
    }

    #[test]
    fn chatterino_badge_url_allowlist() {
        assert_eq!(
            allowed_chatterino_badge_url("https://fourtf.com/chatterino/badges/helper.png"),
            Some("https://fourtf.com/chatterino/badges/helper.png".into())
        );
        assert_eq!(
            allowed_chatterino_badge_url("//fourtf.com/chatterino/badges/helper.PNG"),
            Some("https://fourtf.com/chatterino/badges/helper.PNG".into())
        );
        assert!(
            allowed_chatterino_badge_url("http://fourtf.com/chatterino/badges/x.png").is_none()
        );
        assert!(
            allowed_chatterino_badge_url("https://evil.example/chatterino/badges/x.png").is_none()
        );
        assert!(allowed_chatterino_badge_url("https://fourtf.com/other/x.png").is_none());
        assert!(
            allowed_chatterino_badge_url("https://user@fourtf.com/chatterino/badges/x.png")
                .is_none()
        );
        assert_eq!(
            allowed_chatterino_badge_url("https://fourtf.com/chatterino/badges/x.png?cache=1"),
            Some("https://fourtf.com/chatterino/badges/x.png".into())
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

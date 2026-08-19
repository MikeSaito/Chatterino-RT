use std::time::Duration;

use serde_json::Value;

use super::emotes::{Catalog, EmoteDef};
use super::hub::Hub;

const ATTEMPTS: u32 = 3;

pub async fn load_globals(catalog: &std::sync::Arc<std::sync::Mutex<Catalog>>) {
    let client = http_client();
    let mut map = std::collections::HashMap::new();
    if let Ok(list) = get_json(&client, "https://api.betterttv.net/3/cached/emotes/global").await {
        collect_bttv(&list, &mut map);
    }
    if let Ok(v) = get_json(&client, "https://api.frankerfacez.com/v1/set/global").await {
        collect_ffz_sets(&v, &mut map);
    }
    if let Ok(v) = get_json(&client, "https://7tv.io/v3/emote-sets/global").await {
        collect_7tv_set(&v, &mut map);
    }
    if let Ok(mut cat) = catalog.lock() {
        for (k, v) in map {
            cat.insert_global(k, v);
        }
    }
}

pub async fn load_channel(
    catalog: &std::sync::Arc<std::sync::Mutex<Catalog>>,
    hub: &std::sync::Arc<std::sync::Mutex<Hub>>,
    login: &str,
    room_id: &str,
) {
    let client = http_client();
    let mut map = std::collections::HashMap::new();
    let bttv_url = format!("https://api.betterttv.net/3/cached/users/twitch/{room_id}");
    if let Ok(v) = get_json(&client, &bttv_url).await {
        if let Some(arr) = v.get("channelEmotes") {
            collect_bttv(arr, &mut map);
        }
        if let Some(arr) = v.get("sharedEmotes") {
            collect_bttv(arr, &mut map);
        }
    }
    let ffz_url = format!("https://api.frankerfacez.com/v1/room/{login}");
    if let Ok(v) = get_json(&client, &ffz_url).await {
        collect_ffz_sets(&v, &mut map);
    }
    let stv_url = format!("https://7tv.io/v3/users/twitch/{room_id}");
    if let Ok(v) = get_json(&client, &stv_url).await {
        if let Some(set) = v.get("emote_set") {
            collect_7tv_set(set, &mut map);
        }
    }
    let still_active = hub
        .lock()
        .ok()
        .and_then(|h| h.active.clone())
        .is_some_and(|ch| ch == login);
    if !still_active {
        return;
    }
    if let Ok(mut cat) = catalog.lock() {
        cat.replace_channel(login.to_string(), map);
    }
}

fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .user_agent("WebTV_chats/0.1")
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
        if id.is_empty() || code.is_empty() {
            continue;
        }
        map.insert(
            code.to_string(),
            EmoteDef {
                id: id.to_string(),
                provider: "bttv".into(),
                url: format!("https://cdn.betterttv.net/emote/{id}/1x"),
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
            if code.is_empty() {
                continue;
            }
            let url = item
                .get("urls")
                .and_then(Value::as_object)
                .and_then(|u| u.get("1").or_else(|| u.get("2")).or_else(|| u.get("4")))
                .and_then(Value::as_str)
                .map(abs_url)
                .unwrap_or_default();
            if url.is_empty() {
                continue;
            }
            map.insert(
                code.to_string(),
                EmoteDef {
                    id,
                    provider: "ffz".into(),
                    url,
                },
            );
        }
    }
}

fn collect_7tv_set(value: &Value, map: &mut std::collections::HashMap<String, EmoteDef>) {
    let emotes = value.get("emotes").and_then(Value::as_array);
    let Some(emotes) = emotes else { return };
    for item in emotes {
        let name = item.get("name").and_then(Value::as_str).unwrap_or("");
        let data = item.get("data").unwrap_or(item);
        let id = data.get("id").and_then(Value::as_str).unwrap_or("");
        if name.is_empty() || id.is_empty() {
            continue;
        }
        let host = data
            .get("host")
            .and_then(|h| h.get("url"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let file = data
            .get("host")
            .and_then(|h| h.get("files"))
            .and_then(Value::as_array)
            .and_then(|files| {
                files.iter().find_map(|f| {
                    let n = f.get("name").and_then(Value::as_str)?;
                    if n.starts_with("1x") {
                        Some(n)
                    } else {
                        None
                    }
                })
            })
            .unwrap_or("1x.webp");
        let url = if host.is_empty() {
            format!("https://cdn.7tv.app/emote/{id}/1x.webp")
        } else {
            format!("{}/{file}", abs_url(host))
        };
        map.insert(
            name.to_string(),
            EmoteDef {
                id: id.to_string(),
                provider: "7tv".into(),
                url,
            },
        );
    }
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

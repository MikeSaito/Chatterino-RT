//! User pronouns via alejo.io (Chatterino PronounsAlejoApi; reimplementation, MIT).

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

const API_BASE: &str = "https://api.pronouns.alejo.io/v1";

#[derive(Clone)]
pub(crate) struct PronounEntry {
    subject: String,
    object: String,
    singular: bool,
}

struct PronounsState {
    dictionary: HashMap<String, PronounEntry>,
    /// `None` = unspecified (404 or empty parse); `Some` = display text.
    users: HashMap<String, Option<String>>,
}

impl PronounsState {
    fn new() -> Self {
        Self {
            dictionary: HashMap::new(),
            users: HashMap::new(),
        }
    }
}

static STATE: std::sync::OnceLock<Mutex<PronounsState>> = std::sync::OnceLock::new();

fn state() -> &'static Mutex<PronounsState> {
    STATE.get_or_init(|| Mutex::new(PronounsState::new()))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserPronounsResult {
    /// Known display (`she/her`); `None` = unspecified.
    pub pronouns: Option<String>,
}

fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .user_agent("Chatterino-RT/0.1")
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// Format from dictionary entries (stock `parsePronoun` rules).
pub(crate) fn format_from_entries(
    main: &PronounEntry,
    alt: Option<&PronounEntry>,
) -> String {
    match alt {
        Some(a) => format!("{}/{}", main.subject, a.subject),
        None if main.singular => main.subject.clone(),
        None => format!("{}/{}", main.subject, main.object),
    }
}

pub(crate) fn format_from_ids(
    dictionary: &HashMap<String, PronounEntry>,
    pronoun_id: &str,
    alt_pronoun_id: Option<&str>,
) -> Option<String> {
    let main = dictionary.get(pronoun_id)?;
    if let Some(alt_id) = alt_pronoun_id {
        let alt = dictionary.get(alt_id)?;
        return Some(format_from_entries(main, Some(alt)));
    }
    Some(format_from_entries(main, None))
}

fn parse_dictionary(root: &Value) -> HashMap<String, PronounEntry> {
    let mut out = HashMap::new();
    let Some(obj) = root.as_object() else {
        return out;
    };
    for (id, entry) in obj {
        let Some(map) = entry.as_object() else {
            continue;
        };
        let subject = map
            .get("subject")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let object = map
            .get("object")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if subject.is_empty() || object.is_empty() {
            continue;
        }
        let singular = map
            .get("singular")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        out.insert(
            id.clone(),
            PronounEntry {
                subject: subject.to_string(),
                object: object.to_string(),
                singular,
            },
        );
    }
    out
}

async fn ensure_dictionary() -> Result<(), String> {
    {
        let state = state().lock().map_err(|_| "lock".to_string())?;
        if !state.dictionary.is_empty() {
            return Ok(());
        }
    }
    let url = format!("{API_BASE}/pronouns");
    let resp = http_client()
        .get(&url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        let status = resp.status();
        if status.is_redirection() {
            return Err(format!(
                "pronouns dictionary HTTP {status} (redirects not followed)"
            ));
        }
        return Err(format!("pronouns dictionary HTTP {status}"));
    }
    let body: Value = resp.json().await.map_err(|e| e.to_string())?;
    let parsed = parse_dictionary(&body);
    if parsed.is_empty() {
        return Err("pronouns dictionary empty".into());
    }
    let mut state = state().lock().map_err(|_| "lock".to_string())?;
    if state.dictionary.is_empty() {
        state.dictionary = parsed;
    }
    Ok(())
}

fn parse_user_body(dictionary: &HashMap<String, PronounEntry>, body: &Value) -> Option<String> {
    let pronoun_id = body.get("pronoun_id").and_then(Value::as_str)?.trim();
    if pronoun_id.is_empty() {
        return None;
    }
    let alt = body
        .get("alt_pronoun_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    format_from_ids(dictionary, pronoun_id, alt)
}

/// Lookup pronouns for a normalized Twitch login. `Ok(None)` = unspecified.
pub async fn lookup(login: &str) -> Result<Option<String>, String> {
    {
        let state = state().lock().map_err(|_| "lock".to_string())?;
        if let Some(cached) = state.users.get(login) {
            return Ok(cached.clone());
        }
    }

    ensure_dictionary().await?;

    {
        let state = state().lock().map_err(|_| "lock".to_string())?;
        if state.dictionary.is_empty() {
            return Err("pronoun dictionary unavailable".into());
        }
    }

    let url = format!("{API_BASE}/users/{login}");
    let resp = http_client()
        .get(&url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = resp.status();
    if status.as_u16() == 404 {
        let mut state = state().lock().map_err(|_| "lock".to_string())?;
        state.users.insert(login.to_string(), None);
        return Ok(None);
    }
    if status.is_redirection() {
        return Err(format!("pronouns user HTTP {status} (redirects not followed)"));
    }
    if !status.is_success() {
        return Err(format!("pronouns user HTTP {status}"));
    }
    let body: Value = resp.json().await.map_err(|e| e.to_string())?;
    let text = {
        let state = state().lock().map_err(|_| "lock".to_string())?;
        parse_user_body(&state.dictionary, &body)
    };
    let mut state = state().lock().map_err(|_| "lock".to_string())?;
    state.users.insert(login.to_string(), text.clone());
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(subject: &str, object: &str, singular: bool) -> PronounEntry {
        PronounEntry {
            subject: subject.into(),
            object: object.into(),
            singular,
        }
    }

    #[test]
    fn format_singular() {
        assert_eq!(
            format_from_entries(&entry("they", "them", true), None),
            "they"
        );
    }

    #[test]
    fn format_pair() {
        assert_eq!(
            format_from_entries(&entry("she", "her", false), None),
            "she/her"
        );
    }

    #[test]
    fn format_main_alt() {
        let main = entry("she", "her", false);
        let alt = entry("they", "them", false);
        assert_eq!(format_from_entries(&main, Some(&alt)), "she/they");
    }

    #[test]
    fn format_from_ids_unknown_main() {
        let mut dict = HashMap::new();
        dict.insert("sheher".into(), entry("she", "her", false));
        assert!(format_from_ids(&dict, "missing", None).is_none());
    }

    #[test]
    fn parse_dictionary_skips_empty() {
        let root = serde_json::json!({
            "sheher": { "subject": "she", "object": "her", "singular": false },
            "bad": { "subject": "", "object": "x", "singular": false },
        });
        let dict = parse_dictionary(&root);
        assert_eq!(dict.len(), 1);
        assert!(dict.contains_key("sheher"));
    }

    #[test]
    fn parse_user_404_style_empty_object() {
        let mut dict = HashMap::new();
        dict.insert("sheher".into(), entry("she", "her", false));
        assert!(parse_user_body(&dict, &serde_json::json!({})).is_none());
    }
}

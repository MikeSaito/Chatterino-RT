//! EmotePopup list: tabs Favourite / Subs / Channel / Global / Emojis.

use serde::{Deserialize, Serialize};

use super::commands::ApiError;
use super::emoji::{cdn_prefix_for, unified_code};
use super::emotes::{Catalog, EmoteDef};
use super::settings;
use super::state::Shared;

const LIST_CAP: usize = 200;
const MAX_FAV_CODE: usize = 2000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EmotePopupTab {
    Favourite,
    Subs,
    Channel,
    Global,
    Emojis,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmotePopupItem {
    /// Текст для вставки в input (имя эмодзи или unicode emoji / shortcode unavailable).
    pub code: String,
    pub url: Option<String>,
    /// `emote` | `emoji`
    pub kind: String,
    pub favourite: bool,
}

fn needle_ok(code: &str, query: &str) -> bool {
    if query.is_empty() {
        return true;
    }
    let code_l = code.to_ascii_lowercase();
    let q = query.to_ascii_lowercase();
    code_l.contains(&q)
}

fn has_control(s: &str) -> bool {
    s.chars()
        .any(|c| matches!(c, '\0' | '\r' | '\n' | '\u{0001}'))
}

fn emoji_set(shared: &Shared) -> String {
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

fn fav_sets(shared: &Shared) -> (Vec<String>, Vec<String>) {
    let Ok(settings) = shared.settings.lock() else {
        return (Vec::new(), Vec::new());
    };
    (
        settings.data.favourite_emotes.clone(),
        settings.data.favourite_emojis.clone(),
    )
}

fn is_fav_emote(favs: &[String], code: &str) -> bool {
    favs.iter().any(|f| f == code)
}

fn is_fav_emoji(favs: &[String], shortcode: &str) -> bool {
    favs.iter().any(|f| f == shortcode)
}

fn emote_item(code: &str, def: &EmoteDef, fav: bool) -> EmotePopupItem {
    EmotePopupItem {
        code: code.to_string(),
        url: if def.url.is_empty() {
            None
        } else {
            Some(def.url.clone())
        },
        kind: "emote".into(),
        favourite: fav,
    }
}

fn make_emoji_item(
    unicode: &str,
    shortcode: &str,
    set: &str,
    fav_emojis: &[String],
) -> EmotePopupItem {
    let id = unified_code(unicode);
    let prefix = cdn_prefix_for(set, &id);
    EmotePopupItem {
        code: unicode.to_string(),
        url: Some(format!("{}/{}.png", prefix, id)),
        kind: "emoji".into(),
        favourite: is_fav_emoji(fav_emojis, shortcode),
    }
}

fn push_unique(
    out: &mut Vec<EmotePopupItem>,
    seen: &mut std::collections::HashSet<String>,
    item: EmotePopupItem,
) {
    let key = format!("{}:{}", item.kind, item.code);
    if seen.insert(key) {
        out.push(item);
    }
}

fn sort_pairs(pairs: &mut [(String, EmoteDef)]) {
    pairs.sort_by(|a, b| a.0.to_ascii_lowercase().cmp(&b.0.to_ascii_lowercase()));
}

/// Channel Twitch emotes only (stock Subs via localTwitch / sub-like sets).
fn collect_subs(
    pairs: &[(String, EmoteDef)],
    query: &str,
    fav_emotes: &[String],
    out: &mut Vec<EmotePopupItem>,
    seen: &mut std::collections::HashSet<String>,
) {
    for (code, def) in pairs {
        if out.len() >= LIST_CAP {
            break;
        }
        if def.provider != "twitch" || !needle_ok(code, query) {
            continue;
        }
        push_unique(
            out,
            seen,
            emote_item(code, def, is_fav_emote(fav_emotes, code)),
        );
    }
}

/// Channel third-party only (stock Channel = BTTV/FFZ/7TV).
fn collect_channel(
    pairs: &[(String, EmoteDef)],
    query: &str,
    fav_emotes: &[String],
    out: &mut Vec<EmotePopupItem>,
    seen: &mut std::collections::HashSet<String>,
) {
    for (code, def) in pairs {
        if out.len() >= LIST_CAP {
            break;
        }
        if def.provider == "twitch" || !needle_ok(code, query) {
            continue;
        }
        push_unique(
            out,
            seen,
            emote_item(code, def, is_fav_emote(fav_emotes, code)),
        );
    }
}

fn collect_global(
    pairs: &[(String, EmoteDef)],
    query: &str,
    fav_emotes: &[String],
    out: &mut Vec<EmotePopupItem>,
    seen: &mut std::collections::HashSet<String>,
) {
    for (code, def) in pairs {
        if out.len() >= LIST_CAP {
            break;
        }
        if !needle_ok(code, query) {
            continue;
        }
        push_unique(
            out,
            seen,
            emote_item(code, def, is_fav_emote(fav_emotes, code)),
        );
    }
}

fn collect_emojis(
    query: &str,
    set: &str,
    fav_emojis: &[String],
    out: &mut Vec<EmotePopupItem>,
    seen: &mut std::collections::HashSet<String>,
) {
    for emoji in emojis::iter() {
        if out.len() >= LIST_CAP {
            break;
        }
        let unicode = emoji.as_str();
        let Some(short) = emoji.shortcode() else {
            continue;
        };
        let name = emoji.name();
        let match_ok = query.is_empty()
            || needle_ok(unicode, query)
            || needle_ok(short, query)
            || needle_ok(name, query);
        if !match_ok {
            continue;
        }
        push_unique(out, seen, make_emoji_item(unicode, short, set, fav_emojis));
    }
}

fn collect_favourites(
    catalog: &Catalog,
    channel: &str,
    query: &str,
    set: &str,
    fav_emotes: &[String],
    fav_emojis: &[String],
    out: &mut Vec<EmotePopupItem>,
    seen: &mut std::collections::HashSet<String>,
) {
    for code in fav_emotes {
        if out.len() >= LIST_CAP {
            return;
        }
        if !needle_ok(code, query) {
            continue;
        }
        if let Some(def) = catalog.lookup(channel, code) {
            push_unique(out, seen, emote_item(code, def, true));
        } else {
            // Unavailable favourite: всё равно в UI, чтобы снять Ctrl+click.
            push_unique(
                out,
                seen,
                EmotePopupItem {
                    code: code.clone(),
                    url: None,
                    kind: "emote".into(),
                    favourite: true,
                },
            );
        }
    }
    for short in fav_emojis {
        if out.len() >= LIST_CAP {
            return;
        }
        let Some(emoji) = emojis::get_by_shortcode(short) else {
            if needle_ok(short, query) {
                push_unique(
                    out,
                    seen,
                    EmotePopupItem {
                        code: short.clone(),
                        url: None,
                        kind: "emoji".into(),
                        favourite: true,
                    },
                );
            }
            continue;
        };
        let unicode = emoji.as_str();
        let name = emoji.name();
        let match_ok = query.is_empty()
            || needle_ok(short, query)
            || needle_ok(unicode, query)
            || needle_ok(name, query);
        if !match_ok {
            continue;
        }
        push_unique(out, seen, make_emoji_item(unicode, short, set, fav_emojis));
    }
}

pub fn list(
    shared: &Shared,
    channel: &str,
    tab: EmotePopupTab,
    query: &str,
) -> Result<Vec<EmotePopupItem>, ApiError> {
    let query = query.trim();
    if query.chars().count() > 64 || has_control(query) {
        return Ok(Vec::new());
    }
    let set = emoji_set(shared);
    let (fav_emotes, fav_emojis) = fav_sets(shared);

    let (channel_pairs, global_pairs) = {
        let catalog = shared
            .catalog
            .lock()
            .map_err(|_| ApiError::internal("lock"))?;
        let mut channel_pairs: Vec<(String, EmoteDef)> = catalog
            .iter_channel(channel)
            .map(|(c, d)| (c.clone(), d.clone()))
            .collect();
        let mut global_pairs: Vec<(String, EmoteDef)> = catalog
            .iter_global()
            .map(|(c, d)| (c.clone(), d.clone()))
            .collect();
        sort_pairs(&mut channel_pairs);
        sort_pairs(&mut global_pairs);
        // Favourite tab still needs catalog lookup under a short second lock, or clone snapshot.
        // Keep catalog lock only for the copy above; favourites re-lock briefly.
        (channel_pairs, global_pairs)
    };

    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    match tab {
        EmotePopupTab::Favourite => {
            let catalog = shared
                .catalog
                .lock()
                .map_err(|_| ApiError::internal("lock"))?;
            collect_favourites(
                &catalog,
                channel,
                query,
                &set,
                &fav_emotes,
                &fav_emojis,
                &mut out,
                &mut seen,
            );
        }
        EmotePopupTab::Subs => {
            collect_subs(&channel_pairs, query, &fav_emotes, &mut out, &mut seen);
        }
        EmotePopupTab::Channel => {
            collect_channel(&channel_pairs, query, &fav_emotes, &mut out, &mut seen);
        }
        EmotePopupTab::Global => {
            collect_global(&global_pairs, query, &fav_emotes, &mut out, &mut seen);
        }
        EmotePopupTab::Emojis => {
            collect_emojis(query, &set, &fav_emojis, &mut out, &mut seen);
        }
    }
    Ok(out)
}

fn emoji_shortcode_for_token(code: &str) -> Option<String> {
    let trimmed = code.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(e) = emojis::get(trimmed) {
        return e.shortcode().map(|s| s.to_string());
    }
    if let Some(e) = emojis::get_by_shortcode(trimmed) {
        return e.shortcode().map(|s| s.to_string());
    }
    let inner = trimmed.trim_matches(':');
    if let Some(e) = emojis::get_by_shortcode(inner) {
        return e.shortcode().map(|s| s.to_string());
    }
    None
}

pub fn toggle_favourite(
    shared: &Shared,
    code: &str,
    is_emoji: bool,
    add: bool,
) -> Result<(), ApiError> {
    let code = code.trim();
    if code.is_empty() || code.len() > MAX_FAV_CODE || has_control(code) {
        return Err(ApiError::coded(
            "error.emote.favourite_code",
            "invalid favourite code",
        ));
    }
    if is_emoji {
        let short = emoji_shortcode_for_token(code).unwrap_or_else(|| {
            // Unavailable / unknown shortcode still removable by exact token.
            code.trim_matches(':').to_string()
        });
        if short.is_empty() || has_control(&short) {
            return Err(ApiError::coded(
                "error.emote.unknown_emoji",
                "unknown emoji",
            ));
        }
        settings::mutate_favourites(shared, |_emotes, emojis| {
            if add {
                if !emojis.iter().any(|s| s == &short) {
                    emojis.push(short.clone());
                }
            } else {
                emojis.retain(|s| s != &short);
            }
            Ok(())
        })
    } else {
        let name = code.to_string();
        settings::mutate_favourites(shared, |emotes, _emojis| {
            if add {
                if !emotes.iter().any(|s| s == &name) {
                    emotes.push(name.clone());
                }
            } else {
                emotes.retain(|s| s != &name);
            }
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::emotes::EmoteDef;

    fn sample_catalog() -> Catalog {
        let mut cat = Catalog::default();
        cat.insert_global(
            "Kappa".into(),
            EmoteDef {
                id: "25".into(),
                provider: "twitch".into(),
                url: "https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/1.0".into(),
                zero_width: false,
                display_width: None,
                display_height: None,
            },
        );
        cat.insert_global(
            "PogChamp".into(),
            EmoteDef {
                id: "88".into(),
                provider: "twitch".into(),
                url: "https://example/pog".into(),
                zero_width: false,
                display_width: None,
                display_height: None,
            },
        );
        let mut ch = std::collections::HashMap::new();
        ch.insert(
            "xqcL".into(),
            EmoteDef {
                id: "1".into(),
                provider: "bttv".into(),
                url: "https://cdn.betterttv.net/emote/1/1x".into(),
                zero_width: false,
                display_width: None,
                display_height: None,
            },
        );
        ch.insert(
            "SubOnly".into(),
            EmoteDef {
                id: "99".into(),
                provider: "twitch".into(),
                url: "https://example/sub".into(),
                zero_width: false,
                display_width: None,
                display_height: None,
            },
        );
        cat.replace_channel("xqc".into(), ch);
        cat
    }

    fn channel_pairs(cat: &Catalog, channel: &str) -> Vec<(String, EmoteDef)> {
        let mut pairs: Vec<_> = cat
            .iter_channel(channel)
            .map(|(c, d)| (c.clone(), d.clone()))
            .collect();
        sort_pairs(&mut pairs);
        pairs
    }

    fn global_pairs(cat: &Catalog) -> Vec<(String, EmoteDef)> {
        let mut pairs: Vec<_> = cat
            .iter_global()
            .map(|(c, d)| (c.clone(), d.clone()))
            .collect();
        sort_pairs(&mut pairs);
        pairs
    }

    #[test]
    fn global_filter_contains() {
        let cat = sample_catalog();
        let pairs = global_pairs(&cat);
        let mut out = Vec::new();
        let mut seen = std::collections::HashSet::new();
        collect_global(&pairs, "kap", &[], &mut out, &mut seen);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].code, "Kappa");
        assert_eq!(out[0].kind, "emote");
        assert!(out[0].url.is_some());
    }

    #[test]
    fn channel_lists_third_party_only() {
        let cat = sample_catalog();
        let pairs = channel_pairs(&cat, "xqc");
        let mut out = Vec::new();
        let mut seen = std::collections::HashSet::new();
        collect_channel(&pairs, "", &[], &mut out, &mut seen);
        assert!(out.iter().any(|i| i.code == "xqcL"));
        assert!(!out.iter().any(|i| i.code == "SubOnly"));
    }

    #[test]
    fn subs_only_channel_twitch() {
        let cat = sample_catalog();
        let pairs = channel_pairs(&cat, "xqc");
        let mut out = Vec::new();
        let mut seen = std::collections::HashSet::new();
        collect_subs(&pairs, "", &[], &mut out, &mut seen);
        assert!(out.iter().any(|i| i.code == "SubOnly"));
        assert!(!out.iter().any(|i| i.code == "Kappa"));
        assert!(!out.iter().any(|i| i.code == "xqcL"));
    }

    #[test]
    fn favourites_resolve_and_unavailable() {
        let cat = sample_catalog();
        let mut out = Vec::new();
        let mut seen = std::collections::HashSet::new();
        collect_favourites(
            &cat,
            "xqc",
            "",
            "Twitter",
            &["Kappa".into(), "missing".into()],
            &["smile".into(), "not_a_real_emoji_zz".into()],
            &mut out,
            &mut seen,
        );
        assert!(out
            .iter()
            .any(|i| i.code == "Kappa" && i.favourite && i.url.is_some()));
        assert!(out
            .iter()
            .any(|i| i.code == "missing" && i.favourite && i.url.is_none()));
        assert!(out
            .iter()
            .any(|i| i.kind == "emoji" && i.favourite && i.url.is_some()));
        assert!(out
            .iter()
            .any(|i| { i.code == "not_a_real_emoji_zz" && i.kind == "emoji" && i.url.is_none() }));
    }

    #[test]
    fn emoji_shortcode_roundtrip() {
        assert_eq!(emoji_shortcode_for_token("😀").as_deref(), Some("grinning"));
        assert_eq!(
            emoji_shortcode_for_token("grinning").as_deref(),
            Some("grinning")
        );
    }
}

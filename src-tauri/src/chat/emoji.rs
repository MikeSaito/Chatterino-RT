// SPDX-FileCopyrightText: 2017 Contributors to Chatterino <https://chatterino.com>
// SPDX-License-Identifier: MIT
//
// Reimplementation of unicode emoji scanning from Chatterino
// src/providers/emoji/Emojis.cpp parse(). Not a copy of C++/Qt source or emoji assets.

use unicode_segmentation::UnicodeSegmentation;

use super::types::EmoteSpan;

const EMOJI_CDN_TWITTER: &str =
    "https://cdn.jsdelivr.net/npm/emoji-datasource-twitter@15.1.2/img/twitter/64";
const EMOJI_CDN_FACEBOOK: &str =
    "https://cdn.jsdelivr.net/npm/emoji-datasource-facebook@15.1.2/img/facebook/64";
const EMOJI_CDN_APPLE: &str =
    "https://cdn.jsdelivr.net/npm/emoji-datasource-apple@15.1.2/img/apple/64";
const EMOJI_CDN_GOOGLE: &str =
    "https://cdn.jsdelivr.net/npm/emoji-datasource-google@15.1.2/img/google/64";

/// emoji-datasource@15.1.2: has_img_twitter && !has_img_facebook (Chatterino falls back to Twitter).
const FACEBOOK_MISSING: &[&str] = &[
    "0023-fe0f-20e3",
    "002a-fe0f-20e3",
    "0030-fe0f-20e3",
    "0031-fe0f-20e3",
    "0032-fe0f-20e3",
    "0033-fe0f-20e3",
    "0034-fe0f-20e3",
    "0035-fe0f-20e3",
    "0036-fe0f-20e3",
    "0037-fe0f-20e3",
    "0038-fe0f-20e3",
    "0039-fe0f-20e3",
    "00a9-fe0f",
    "00ae-fe0f",
    "1f3cb-fe0f-200d-2640-fe0f",
    "1f3cb-fe0f-200d-2642-fe0f",
    "1f3cc-fe0f-200d-2640-fe0f",
    "1f3cc-fe0f-200d-2642-fe0f",
    "1f3f3-fe0f-200d-26a7-fe0f",
    "1f441-fe0f-200d-1f5e8-fe0f",
    "1f575-fe0f-200d-2640-fe0f",
    "1f575-fe0f-200d-2642-fe0f",
    "26f9-fe0f-200d-2640-fe0f",
    "26f9-fe0f-200d-2642-fe0f",
];

/// emoji-datasource@15.1.2: has_img_twitter && !has_img_apple.
const APPLE_MISSING: &[&str] = &["2640-fe0f", "2642-fe0f", "2695-fe0f"];

/// jsdelivr emoji-datasource img prefix for Settings `emotes.emojiSet`.
pub fn cdn_prefix(set: &str) -> &'static str {
    match set.trim().to_ascii_lowercase().as_str() {
        "facebook" => EMOJI_CDN_FACEBOOK,
        "apple" => EMOJI_CDN_APPLE,
        "google" => EMOJI_CDN_GOOGLE,
        "twitter" | _ => EMOJI_CDN_TWITTER,
    }
}

/// Prefix for one emoji: incomplete Facebook/Apple sets fall back to Twitter (stock loadEmojiSet).
pub fn cdn_prefix_for(set: &str, unified: &str) -> &'static str {
    let wanted = cdn_prefix(set);
    if wanted == EMOJI_CDN_TWITTER {
        return wanted;
    }
    let id = unified.trim().to_ascii_lowercase();
    let missing = if wanted == EMOJI_CDN_FACEBOOK {
        FACEBOOK_MISSING
    } else if wanted == EMOJI_CDN_APPLE {
        APPLE_MISSING
    } else {
        return wanted;
    };
    if missing.iter().any(|m| *m == id) {
        EMOJI_CDN_TWITTER
    } else {
        wanted
    }
}

pub fn attach_emoji(text: &str, existing: &[EmoteSpan], set: &str) -> Vec<EmoteSpan> {
    let mut extra = Vec::new();
    let mut utf16 = 0u32;
    for grapheme in text.graphemes(true) {
        let len = grapheme.chars().map(|c| c.len_utf16() as u32).sum::<u32>();
        let start = utf16;
        let end = utf16 + len;
        utf16 = end;
        let Some(emoji) = lookup_emoji(grapheme) else {
            continue;
        };
        if overlaps(existing, start, end) || overlaps(&extra, start, end) {
            continue;
        }
        let qualified = emoji.as_str();
        let id = unified_code(qualified);
        let prefix = cdn_prefix_for(set, &id);
        extra.push(EmoteSpan {
            start,
            end,
            emote_id: id.clone(),
            provider: "emoji".into(),
            url: format!("{}/{}.png", prefix, id),
            zero_width: false,
            bits_amount: None,
            bits_color: None,
        });
    }
    extra
}

fn unified_code(emoji: &str) -> String {
    let mut out = String::new();
    for c in emoji.chars() {
        if !out.is_empty() {
            out.push('-');
        }
        out.push_str(&format!("{:04x}", c as u32));
    }
    out
}

fn lookup_emoji(grapheme: &str) -> Option<&'static emojis::Emoji> {
    if let Some(found) = emojis::get(grapheme) {
        return Some(found);
    }
    if let Some(stripped) = grapheme.strip_suffix('\u{fe0f}') {
        if let Some(found) = emojis::get(stripped) {
            return Some(found);
        }
    }
    if !needs_vs16_retry(grapheme) {
        return None;
    }
    let mut qualified = String::with_capacity(grapheme.len() + 3);
    qualified.push_str(grapheme);
    qualified.push('\u{fe0f}');
    emojis::get(&qualified)
}

fn needs_vs16_retry(grapheme: &str) -> bool {
    let mut chars = grapheme.chars();
    let Some(c) = chars.next() else {
        return false;
    };
    if chars.next().is_some() {
        return false;
    }
    matches!(c, '#' | '*' | '0'..='9') || (!c.is_alphabetic() && c as u32 >= 0xa9)
}

fn overlaps(spans: &[EmoteSpan], start: u32, end: u32) -> bool {
    spans.iter().any(|s| start < s.end && end > s.start)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attaches_unicode_emoji() {
        let extra = attach_emoji("hi 😀", &[], "Twitter");
        assert_eq!(extra.len(), 1);
        assert_eq!(extra[0].start, 3);
        assert_eq!(extra[0].end, 5);
        assert_eq!(extra[0].provider, "emoji");
        assert_eq!(extra[0].zero_width, false);
        assert!(extra[0].url.starts_with(EMOJI_CDN_TWITTER));
        assert!(extra[0].url.ends_with("/1f600.png"));
    }

    #[test]
    fn cdn_prefix_selects_set() {
        assert_eq!(cdn_prefix("Twitter"), EMOJI_CDN_TWITTER);
        assert_eq!(cdn_prefix("Facebook"), EMOJI_CDN_FACEBOOK);
        assert_eq!(cdn_prefix("Apple"), EMOJI_CDN_APPLE);
        assert_eq!(cdn_prefix("Google"), EMOJI_CDN_GOOGLE);
        assert_eq!(cdn_prefix("Nope"), EMOJI_CDN_TWITTER);
        assert_eq!(cdn_prefix(" google "), EMOJI_CDN_GOOGLE);
    }

    #[test]
    fn set_changes_url_path() {
        let tw = attach_emoji("😀", &[], "Twitter");
        let go = attach_emoji("😀", &[], "Google");
        assert_eq!(tw[0].emote_id, go[0].emote_id);
        assert!(tw[0].url.contains("/twitter/64/"));
        assert!(go[0].url.contains("/google/64/"));
        assert!(!go[0].url.contains("/twitter/"));
    }

    #[test]
    fn incomplete_set_falls_back_to_twitter() {
        let copy = attach_emoji("\u{a9}", &[], "Facebook");
        assert_eq!(copy.len(), 1);
        assert!(
            copy[0].url.starts_with(EMOJI_CDN_TWITTER),
            "{}",
            copy[0].url
        );
        assert!(copy[0].url.ends_with("/00a9-fe0f.png"));
        let female = attach_emoji("\u{2640}\u{fe0f}", &[], "Apple");
        assert_eq!(female.len(), 1);
        assert!(
            female[0].url.starts_with(EMOJI_CDN_TWITTER),
            "{}",
            female[0].url
        );
        let smile = attach_emoji("😀", &[], "Facebook");
        assert!(smile[0].url.contains("/facebook/64/"));
    }

    #[test]
    fn skips_overlap_with_twitch() {
        let twitch = vec![EmoteSpan {
            start: 0,
            end: 2,
            emote_id: "25".into(),
            provider: "twitch".into(),
            url: "x".into(),
            zero_width: false,
            bits_amount: None,
            bits_color: None,
        }];
        let extra = attach_emoji("😀 rest", &twitch, "Twitter");
        assert!(extra.is_empty());
    }

    #[test]
    fn ignores_plain_text() {
        assert!(attach_emoji("Kappa Pog", &[], "Twitter").is_empty());
    }

    #[test]
    fn uses_datasource_unified_names() {
        let heart = attach_emoji("\u{2764}", &[], "Twitter");
        assert_eq!(heart.len(), 1);
        assert!(
            heart[0].url.ends_with("/2764-fe0f.png"),
            "{}",
            heart[0].url
        );
        let copy = attach_emoji("\u{a9}", &[], "Apple");
        assert_eq!(copy.len(), 1);
        assert!(
            copy[0].url.contains("/apple/64/"),
            "{}",
            copy[0].url
        );
        assert!(
            copy[0].url.ends_with("/00a9-fe0f.png"),
            "{}",
            copy[0].url
        );
    }

    #[test]
    fn strips_overqualified_vs16() {
        let extra = attach_emoji("😀\u{fe0f}", &[], "Facebook");
        assert_eq!(extra.len(), 1);
        assert!(extra[0].url.contains("/facebook/64/"));
        assert!(extra[0].url.ends_with("/1f600.png"), "{}", extra[0].url);
    }
}

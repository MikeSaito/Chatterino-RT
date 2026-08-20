// SPDX-FileCopyrightText: 2017 Contributors to Chatterino <https://chatterino.com>
// SPDX-License-Identifier: MIT
//
// Reimplementation of unicode emoji scanning from Chatterino
// src/providers/emoji/Emojis.cpp parse(). Not a copy of C++/Qt source or emoji assets.

use unicode_segmentation::UnicodeSegmentation;

use super::types::EmoteSpan;

const EMOJI_CDN: &str = "https://cdn.jsdelivr.net/npm/emoji-datasource-twitter@15.1.2/img/twitter/64";

pub fn attach_emoji(text: &str, existing: &[EmoteSpan]) -> Vec<EmoteSpan> {
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
        extra.push(EmoteSpan {
            start,
            end,
            emote_id: unified_code(qualified),
            provider: "emoji".into(),
            url: emoji_url(qualified),
            zero_width: false,
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

fn emoji_url(emoji: &str) -> String {
    format!("{}/{}.png", EMOJI_CDN, unified_code(emoji))
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
        let extra = attach_emoji("hi 😀", &[]);
        assert_eq!(extra.len(), 1);
        assert_eq!(extra[0].start, 3);
        assert_eq!(extra[0].end, 5);
        assert_eq!(extra[0].provider, "emoji");
        assert_eq!(extra[0].zero_width, false);
        assert!(extra[0].url.starts_with(EMOJI_CDN));
        assert!(extra[0].url.ends_with("/1f600.png"));
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
        }];
        let extra = attach_emoji("😀 rest", &twitch);
        assert!(extra.is_empty());
    }

    #[test]
    fn ignores_plain_text() {
        assert!(attach_emoji("Kappa Pog", &[]).is_empty());
    }

    #[test]
    fn uses_datasource_unified_names() {
        let heart = attach_emoji("\u{2764}", &[]);
        assert_eq!(heart.len(), 1);
        assert!(
            heart[0].url.ends_with("/2764-fe0f.png"),
            "{}",
            heart[0].url
        );
        let copy = attach_emoji("\u{a9}", &[]);
        assert_eq!(copy.len(), 1);
        assert!(
            copy[0].url.ends_with("/00a9-fe0f.png"),
            "{}",
            copy[0].url
        );
    }

    #[test]
    fn strips_overqualified_vs16() {
        let extra = attach_emoji("😀\u{fe0f}", &[]);
        assert_eq!(extra.len(), 1);
        assert!(extra[0].url.ends_with("/1f600.png"), "{}", extra[0].url);
    }
}

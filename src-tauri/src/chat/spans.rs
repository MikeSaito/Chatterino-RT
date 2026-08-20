// SPDX-FileCopyrightText: 2018 Contributors to Chatterino <https://chatterino.com>
// SPDX-License-Identifier: MIT
//
// Reimplementation of autolink and @mention spans from Chatterino
// src/common/LinkParser.cpp and src/messages/MessageBuilder.cpp.
// Not a copy of C++/Qt source.

use super::types::{EmoteSpan, LinkSpan, MentionSpan};
use url::Url;

const TRAILING: &[char] = &['>', '?', '!', '.', ',', ':', '*', '~', ')'];

pub fn decorate_text_spans(text: &str, emotes: &[EmoteSpan]) -> (Vec<LinkSpan>, Vec<MentionSpan>) {
    let links = parse_links(text, emotes);
    let mentions = parse_mentions(text, emotes, &links);
    (links, mentions)
}

pub fn allowed_chat_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.bytes().any(|b| b < 0x20 || b == b'\\') {
        return Err("недопустимый url".into());
    }
    let parsed = Url::parse(trimmed).map_err(|_| "недопустимый url".to_string())?;
    match parsed.scheme() {
        "https" | "http" => {}
        _ => return Err("только http или https".into()),
    }
    if parsed.host_str().map(|h| h.is_empty()).unwrap_or(true) {
        return Err("нет хоста".into());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("userinfo запрещён".into());
    }
    Ok(parsed.as_str().to_string())
}

fn parse_links(text: &str, emotes: &[EmoteSpan]) -> Vec<LinkSpan> {
    let chars: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    let mut utf16 = 0u32;
    while i < chars.len() {
        if let Some(scheme_chars) = scheme_len(&chars[i..]) {
            let start_u16 = utf16;
            let mut end = i + scheme_chars;
            while end < chars.len() && !chars[end].is_whitespace() && chars[end] != '<' {
                end += 1;
            }
            end = i + strip_url_tail(&chars[i..end], scheme_chars);
            let candidate: String = chars[i..end].iter().collect();
            let span_end = start_u16 + utf16_len(&chars[i..end]);
            if !overlaps(emotes, start_u16, span_end) && !overlaps_links(&out, start_u16, span_end) {
                if let Ok(url) = allowed_chat_url(&candidate) {
                    out.push(LinkSpan {
                        start: start_u16,
                        end: span_end,
                        url,
                    });
                }
            }
            utf16 += utf16_len(&chars[i..end]);
            i = end;
            continue;
        }
        utf16 += chars[i].len_utf16() as u32;
        i += 1;
    }
    out
}

fn parse_mentions(text: &str, emotes: &[EmoteSpan], links: &[LinkSpan]) -> Vec<MentionSpan> {
    let mut out = Vec::new();
    let mut utf16 = 0u32;
    for segment in text.split_inclusive(|c: char| c.is_whitespace()) {
        let word = segment.trim_end_matches(|c: char| c.is_whitespace());
        if let Some(login) = mention_login(word) {
            let start = utf16;
            let end = utf16 + 1 + utf16_str(login);
            if !overlaps(emotes, start, end) && !overlaps_links(links, start, end) {
                out.push(MentionSpan {
                    start,
                    end,
                    login: login.to_ascii_lowercase(),
                });
            }
        }
        utf16 += utf16_str(segment);
    }
    out
}

fn strip_url_tail(chars: &[char], scheme_chars: usize) -> usize {
    let mut end = chars.len();
    while end > scheme_chars {
        let c = chars[end - 1];
        if c == ')' {
            let open = chars[..end].iter().filter(|x| **x == '(').count();
            let close = chars[..end].iter().filter(|x| **x == ')').count();
            if close <= open {
                break;
            }
        }
        if TRAILING.contains(&c) {
            end -= 1;
            continue;
        }
        break;
    }
    end
}

fn mention_login(word: &str) -> Option<&str> {
    let rest = word.strip_prefix('@')?;
    let login = rest
        .trim_end_matches(|c: char| !c.is_ascii_alphanumeric() && c != '_');
    if login.is_empty() || login.len() > 25 {
        return None;
    }
    if !login
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_')
    {
        return None;
    }
    Some(login)
}

fn scheme_len(chars: &[char]) -> Option<usize> {
    const HTTPS: &[char] = &['h', 't', 't', 'p', 's', ':', '/', '/'];
    const HTTP: &[char] = &['h', 't', 't', 'p', ':', '/', '/'];
    if starts_ignore_case(chars, HTTPS) {
        Some(8)
    } else if starts_ignore_case(chars, HTTP) {
        Some(7)
    } else {
        None
    }
}

fn starts_ignore_case(chars: &[char], pat: &[char]) -> bool {
    if chars.len() < pat.len() {
        return false;
    }
    chars
        .iter()
        .take(pat.len())
        .map(|c| c.to_ascii_lowercase())
        .eq(pat.iter().copied())
}

fn utf16_str(s: &str) -> u32 {
    s.chars().map(|c| c.len_utf16() as u32).sum()
}

fn utf16_len(chars: &[char]) -> u32 {
    chars.iter().map(|c| c.len_utf16() as u32).sum()
}

fn overlaps(emotes: &[EmoteSpan], start: u32, end: u32) -> bool {
    emotes.iter().any(|s| start < s.end && end > s.start)
}

fn overlaps_links(links: &[LinkSpan], start: u32, end: u32) -> bool {
    links.iter().any(|s| start < s.end && end > s.start)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn twitch(start: u32, end: u32) -> EmoteSpan {
        EmoteSpan {
            start,
            end,
            emote_id: "25".into(),
            provider: "twitch".into(),
            url: "x".into(),
        }
    }

    #[test]
    fn links_and_mentions_skip_emotes() {
        let text = "Kappa see https://example.com and @bob!";
        let emotes = vec![twitch(0, 5)];
        let (links, mentions) = decorate_text_spans(text, &emotes);
        assert_eq!(links.len(), 1);
        assert_eq!(&text[links[0].start as usize..links[0].end as usize], "https://example.com");
        assert_eq!(links[0].url, "https://example.com/");
        assert_eq!(mentions.len(), 1);
        assert_eq!(mentions[0].login, "bob");
        assert_eq!(&text[mentions[0].start as usize..mentions[0].end as usize], "@bob");
    }

    #[test]
    fn rejects_javascript_and_userinfo() {
        assert!(allowed_chat_url("javascript:alert(1)").is_err());
        assert!(allowed_chat_url("https://user:pass@evil.test/").is_err());
        assert!(allowed_chat_url("https://example.com/a").is_ok());
        assert!(allowed_chat_url("http://example.com").is_ok());
        assert!(allowed_chat_url("file:///etc/passwd").is_err());
    }

    #[test]
    fn utf16_link_after_non_bmp() {
        let text = "😀 https://example.com";
        let (links, _) = decorate_text_spans(text, &[]);
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].start, 3);
    }

    #[test]
    fn link_does_not_eat_trailing_punct() {
        let text = "go https://example.com.";
        let (links, _) = decorate_text_spans(text, &[]);
        assert_eq!(links.len(), 1);
        assert_eq!(&text[links[0].start as usize..links[0].end as usize], "https://example.com");
    }

    #[test]
    fn keeps_balanced_parens_in_path() {
        let text = "see https://example.com/Foo_(bar)";
        let (links, _) = decorate_text_spans(text, &[]);
        assert_eq!(links.len(), 1);
        assert_eq!(
            &text[links[0].start as usize..links[0].end as usize],
            "https://example.com/Foo_(bar)"
        );
    }
}

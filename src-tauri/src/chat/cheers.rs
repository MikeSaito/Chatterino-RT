// SPDX-FileCopyrightText: 2018 Contributors to Chatterino <https://chatterino.com>
// SPDX-License-Identifier: MIT
//
// Reimplementation of cheermote word matching from Chatterino
// src/messages/MessageBuilder.cpp tryAppendCheermote and TwitchChannel::cheerEmote.
// Not a copy of C++/Qt source.

use std::collections::HashMap;

use super::types::EmoteSpan;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheerTier {
    pub min_bits: u32,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheerSet {
    pub prefix: String,
    pub tiers: Vec<CheerTier>,
}

#[derive(Debug, Default)]
pub struct CheerCatalog {
    channel: HashMap<String, Vec<CheerSet>>,
}

impl CheerCatalog {
    pub fn replace_channel(&mut self, channel: String, sets: Vec<CheerSet>) {
        self.channel.insert(channel, sets);
    }

    pub fn retain_channel(&mut self, channel: &str) {
        self.channel.retain(|k, _| k == channel);
    }

    pub fn clear_channels(&mut self) {
        self.channel.clear();
    }

    pub fn sets(&self, channel: &str) -> &[CheerSet] {
        self.channel.get(channel).map(Vec::as_slice).unwrap_or(&[])
    }
}

pub fn attach_cheers(
    text: &str,
    existing: &[EmoteSpan],
    catalog: &CheerCatalog,
    channel: &str,
    bits: u32,
) -> Vec<EmoteSpan> {
    if bits == 0 {
        return Vec::new();
    }
    let sets = catalog.sets(channel);
    if sets.is_empty() {
        return Vec::new();
    }
    let mut extra = Vec::new();
    let mut bits_left = bits;
    let mut utf16 = 0usize;
    for segment in text.split_inclusive(|c: char| c.is_whitespace()) {
        let word = segment.trim_end_matches(|c: char| c.is_whitespace());
        if bits_left > 0 && !word.is_empty() {
            if let Some(hit) = match_cheer(word, sets) {
                if hit.amount <= bits_left {
                    let start = utf16 as u32;
                    let end = start + hit.prefix_utf16;
                    if !overlaps(existing, start, end) && !overlaps(&extra, start, end) {
                        bits_left -= hit.amount;
                        extra.push(EmoteSpan {
                            start,
                            end,
                            emote_id: format!(
                                "{}-{}",
                                hit.prefix.to_ascii_lowercase(),
                                hit.min_bits
                            ),
                            provider: "cheer".into(),
                            url: hit.url,
                            zero_width: false,
                        });
                    }
                }
            }
        }
        utf16 += segment.chars().map(|c| c.len_utf16()).sum::<usize>();
    }
    extra
}

struct CheerHit {
    prefix: String,
    prefix_utf16: u32,
    amount: u32,
    min_bits: u32,
    url: String,
}

fn match_cheer(word: &str, sets: &[CheerSet]) -> Option<CheerHit> {
    for set in sets {
        let Some(rest) = strip_prefix_ci(word, &set.prefix) else {
            continue;
        };
        let Some(amount) = parse_cheer_amount(rest) else {
            continue;
        };
        let Some(tier) = set.tiers.iter().find(|t| amount >= t.min_bits) else {
            continue;
        };
        let prefix_utf16 = set.prefix.chars().map(|c| c.len_utf16() as u32).sum();
        return Some(CheerHit {
            prefix: set.prefix.clone(),
            prefix_utf16,
            amount,
            min_bits: tier.min_bits,
            url: tier.url.clone(),
        });
    }
    None
}

fn strip_prefix_ci<'a>(word: &'a str, prefix: &str) -> Option<&'a str> {
    if prefix.is_empty() || !prefix.is_ascii() || !word.is_ascii() {
        return None;
    }
    if word.len() <= prefix.len() {
        return None;
    }
    if !word[..prefix.len()].eq_ignore_ascii_case(prefix) {
        return None;
    }
    Some(&word[prefix.len()..])
}

fn parse_cheer_amount(digits: &str) -> Option<u32> {
    let bytes = digits.as_bytes();
    if bytes.is_empty() || bytes[0] == b'0' || !bytes.iter().all(u8::is_ascii_digit) {
        return None;
    }
    digits.parse().ok()
}

fn overlaps(spans: &[EmoteSpan], start: u32, end: u32) -> bool {
    spans.iter().any(|s| start < s.end && end > s.start)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cat_with_cheer() -> CheerCatalog {
        let mut cat = CheerCatalog::default();
        cat.replace_channel(
            "xqc".into(),
            vec![CheerSet {
                prefix: "Cheer".into(),
                tiers: vec![
                    CheerTier {
                        min_bits: 100,
                        url: "https://d3aqoihi2n8ty8.cloudfront.net/100.gif".into(),
                    },
                    CheerTier {
                        min_bits: 1,
                        url: "https://d3aqoihi2n8ty8.cloudfront.net/1.gif".into(),
                    },
                ],
            }],
        );
        cat
    }

    #[test]
    fn cheer100_covers_prefix_only() {
        let extra = attach_cheers("hi Cheer100 there", &[], &cat_with_cheer(), "xqc", 100);
        assert_eq!(extra.len(), 1);
        assert_eq!(extra[0].start, 3);
        assert_eq!(extra[0].end, 8);
        assert_eq!(extra[0].provider, "cheer");
        assert_eq!(extra[0].emote_id, "cheer-100");
        assert!(extra[0].url.contains("100.gif"));
    }

    #[test]
    fn cheer_match_is_case_insensitive() {
        let extra = attach_cheers("cheer1", &[], &cat_with_cheer(), "xqc", 1);
        assert_eq!(extra.len(), 1);
        assert_eq!(extra[0].start, 0);
        assert_eq!(extra[0].end, 5);
        assert_eq!(extra[0].emote_id, "cheer-1");
    }

    #[test]
    fn bits_left_skips_overspend() {
        let extra = attach_cheers("Cheer100 Cheer1", &[], &cat_with_cheer(), "xqc", 100);
        assert_eq!(extra.len(), 1);
        assert_eq!(extra[0].start, 0);
        assert_eq!(extra[0].end, 5);
        assert!(attach_cheers("Cheer100", &[], &cat_with_cheer(), "xqc", 50).is_empty());
    }

    #[test]
    fn zero_bits_attaches_nothing() {
        let extra = attach_cheers("Cheer1", &[], &cat_with_cheer(), "xqc", 0);
        assert!(extra.is_empty());
    }

    #[test]
    fn does_not_overlap_twitch_emote() {
        let twitch = vec![EmoteSpan {
            start: 0,
            end: 5,
            emote_id: "25".into(),
            provider: "twitch".into(),
            url: "x".into(),
            zero_width: false,
        }];
        let extra = attach_cheers("Kappa Cheer1", &twitch, &cat_with_cheer(), "xqc", 1);
        assert_eq!(extra.len(), 1);
        assert_eq!(extra[0].start, 6);
        assert_eq!(extra[0].end, 11);
    }

    #[test]
    fn skips_non_matching_prefix_and_tries_next() {
        let mut cat = CheerCatalog::default();
        cat.replace_channel(
            "xqc".into(),
            vec![
                CheerSet {
                    prefix: "BibleThump".into(),
                    tiers: vec![CheerTier {
                        min_bits: 1,
                        url: "https://d3aqoihi2n8ty8.cloudfront.net/bt.gif".into(),
                    }],
                },
                CheerSet {
                    prefix: "Cheer".into(),
                    tiers: vec![CheerTier {
                        min_bits: 1,
                        url: "https://d3aqoihi2n8ty8.cloudfront.net/1.gif".into(),
                    }],
                },
            ],
        );
        let extra = attach_cheers("Cheer1", &[], &cat, "xqc", 1);
        assert_eq!(extra.len(), 1);
        assert_eq!(extra[0].emote_id, "cheer-1");
        assert!(extra[0].url.contains("1.gif"));
    }

    #[test]
    fn leading_zero_is_not_a_cheer() {
        let extra = attach_cheers("Cheer01", &[], &cat_with_cheer(), "xqc", 1);
        assert!(extra.is_empty());
    }
}

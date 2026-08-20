use super::types::EmoteSpan;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmoteDef {
    pub id: String,
    pub provider: String,
    pub url: String,
    pub zero_width: bool,
}

#[derive(Debug, Default)]
pub struct Catalog {
    global: std::collections::HashMap<String, EmoteDef>,
    channel: std::collections::HashMap<String, std::collections::HashMap<String, EmoteDef>>,
}

impl Catalog {
    pub fn insert_global(&mut self, code: String, def: EmoteDef) {
        self.global.insert(code, def);
    }

    pub fn replace_channel(&mut self, channel: String, map: std::collections::HashMap<String, EmoteDef>) {
        self.channel.insert(channel, map);
    }

    pub fn retain_channel(&mut self, channel: &str) {
        self.channel.retain(|k, _| k == channel);
    }

    pub fn clear_channels(&mut self) {
        self.channel.clear();
    }

    pub fn lookup(&self, channel: &str, code: &str) -> Option<&EmoteDef> {
        self.channel
            .get(channel)
            .and_then(|m| m.get(code))
            .or_else(|| self.global.get(code))
    }
}

pub fn attach_third_party(
    text: &str,
    twitch: &[EmoteSpan],
    catalog: &Catalog,
    channel: &str,
) -> Vec<EmoteSpan> {
    let mut extra = Vec::new();
    let mut utf16 = 0usize;
    for segment in text.split_inclusive(|c: char| c == ' ') {
        let word = segment.trim_end_matches(' ');
        let word_utf16 = word.chars().map(|c| c.len_utf16()).sum::<usize>();
        if !word.is_empty() {
            if let Some(def) = catalog.lookup(channel, word) {
                let start = utf16 as u32;
                let end = (utf16 + word_utf16) as u32;
                if !overlaps(twitch, start, end) && !overlaps(&extra, start, end) {
                    extra.push(EmoteSpan {
                        start,
                        end,
                        emote_id: def.id.clone(),
                        provider: def.provider.clone(),
                        url: def.url.clone(),
                        zero_width: def.zero_width,
                    });
                }
            }
        }
        utf16 += segment.chars().map(|c| c.len_utf16()).sum::<usize>();
    }
    extra
}

pub fn resolve_overlays(text: &str, spans: &mut [EmoteSpan]) {
    for i in 0..spans.len() {
        if !spans[i].zero_width {
            continue;
        }
        if i == 0 {
            spans[i].zero_width = false;
            continue;
        }
        let prev_end = spans[i - 1].end;
        let start = spans[i].start;
        spans[i].zero_width = only_whitespace_utf16(text, prev_end, start);
    }
}

fn only_whitespace_utf16(text: &str, start: u32, end: u32) -> bool {
    if start > end {
        return false;
    }
    let mut i = 0u32;
    for c in text.chars() {
        let next = i + c.len_utf16() as u32;
        if next > start && i < end && c != ' ' {
            return false;
        }
        i = next;
        if i >= end {
            break;
        }
    }
    true
}

fn overlaps(spans: &[EmoteSpan], start: u32, end: u32) -> bool {
    spans.iter().any(|s| start < s.end && end > s.start)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn def(id: &str, provider: &str, zero_width: bool) -> EmoteDef {
        EmoteDef {
            id: id.into(),
            provider: provider.into(),
            url: "https://cdn.7tv.app/emote/1/1x.webp".into(),
            zero_width,
        }
    }

    fn span(start: u32, end: u32, provider: &str, zero_width: bool) -> EmoteSpan {
        EmoteSpan {
            start,
            end,
            emote_id: "1".into(),
            provider: provider.into(),
            url: "x".into(),
            zero_width,
        }
    }

    #[test]
    fn attaches_word_emote_without_overlapping_twitch() {
        let mut cat = Catalog::default();
        cat.insert_global("Pog".into(), def("1", "bttv", false));
        let twitch = vec![span(0, 5, "twitch", false)];
        let extra = attach_third_party("Kappa Pog", &twitch, &cat, "xqc");
        assert_eq!(extra.len(), 1);
        assert_eq!(extra[0].start, 6);
        assert_eq!(extra[0].end, 9);
        assert!(!extra[0].zero_width);
    }

    #[test]
    fn copies_zero_width_from_catalog() {
        let mut cat = Catalog::default();
        cat.insert_global("cvHazmat".into(), def("z", "7tv", true));
        let extra = attach_third_party("Kappa cvHazmat", &[], &cat, "xqc");
        assert_eq!(extra.len(), 1);
        assert!(extra[0].zero_width);
    }

    #[test]
    fn overlay_requires_previous_emote() {
        let mut spans = vec![span(0, 8, "7tv", true)];
        resolve_overlays("cvHazmat", &mut spans);
        assert!(!spans[0].zero_width);
    }

    #[test]
    fn overlay_stacks_on_previous_emote() {
        let mut spans = vec![
            span(0, 5, "twitch", false),
            span(6, 14, "7tv", true),
        ];
        resolve_overlays("Kappa cvHazmat", &mut spans);
        assert!(!spans[0].zero_width);
        assert!(spans[1].zero_width);
    }

    #[test]
    fn overlay_skipped_when_text_between() {
        let mut spans = vec![
            span(0, 5, "twitch", false),
            span(12, 20, "7tv", true),
        ];
        resolve_overlays("Kappa hello cvHazmat", &mut spans);
        assert!(!spans[1].zero_width);
    }

    #[test]
    fn tab_does_not_split_third_party_word() {
        let mut cat = Catalog::default();
        cat.insert_global("cvHazmat".into(), def("z", "7tv", true));
        let extra = attach_third_party("Kappa\tcvHazmat", &[], &cat, "xqc");
        assert!(extra.is_empty());
    }
}

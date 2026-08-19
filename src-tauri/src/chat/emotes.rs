use super::types::EmoteSpan;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmoteDef {
    pub id: String,
    pub provider: String,
    pub url: String,
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
    for segment in text.split_inclusive(|c: char| c.is_whitespace()) {
        let word = segment.trim_end_matches(|c: char| c.is_whitespace());
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
                    });
                }
            }
        }
        utf16 += segment.chars().map(|c| c.len_utf16()).sum::<usize>();
    }
    extra
}

fn overlaps(spans: &[EmoteSpan], start: u32, end: u32) -> bool {
    spans.iter().any(|s| start < s.end && end > s.start)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attaches_word_emote_without_overlapping_twitch() {
        let mut cat = Catalog::default();
        cat.insert_global(
            "Pog".into(),
            EmoteDef {
                id: "1".into(),
                provider: "bttv".into(),
                url: "https://cdn.betterttv.net/emote/1/1x".into(),
            },
        );
        let twitch = vec![EmoteSpan {
            start: 0,
            end: 5,
            emote_id: "25".into(),
            provider: "twitch".into(),
            url: "x".into(),
        }];
        let extra = attach_third_party("Kappa Pog", &twitch, &cat, "xqc");
        assert_eq!(extra.len(), 1);
        assert_eq!(extra[0].start, 6);
        assert_eq!(extra[0].end, 9);
    }
}

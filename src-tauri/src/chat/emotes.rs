use super::types::EmoteSpan;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmoteDef {
    pub id: String,
    pub provider: String,
    pub url: String,
    pub zero_width: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SetScope {
    Global,
    Channel(String),
}

#[derive(Debug, Default)]
pub struct Catalog {
    global: std::collections::HashMap<String, EmoteDef>,
    channel: std::collections::HashMap<String, std::collections::HashMap<String, EmoteDef>>,
    set_scope: std::collections::HashMap<String, SetScope>,
    load_gen: u64,
    global_load_gen: u64,
}

impl Catalog {
    pub fn bump_load(&mut self) -> u64 {
        self.load_gen = self.load_gen.wrapping_add(1);
        self.load_gen
    }

    pub fn load_gen(&self) -> u64 {
        self.load_gen
    }

    pub fn bump_global_load(&mut self) -> u64 {
        self.global_load_gen = self.global_load_gen.wrapping_add(1);
        self.global_load_gen
    }

    pub fn global_load_gen(&self) -> u64 {
        self.global_load_gen
    }

    pub fn insert_global(&mut self, code: String, def: EmoteDef) {
        self.global.insert(code, def);
    }

    pub fn insert_global_vacant(&mut self, code: String, def: EmoteDef) {
        self.global.entry(code).or_insert(def);
    }

    pub fn merge_channel_vacant(
        &mut self,
        channel: &str,
        incoming: std::collections::HashMap<String, EmoteDef>,
    ) {
        let map = self
            .channel
            .entry(channel.to_string())
            .or_default();
        for (code, def) in incoming {
            map.entry(code).or_insert(def);
        }
    }

    pub fn replace_channel(&mut self, channel: String, map: std::collections::HashMap<String, EmoteDef>) {
        self.channel.insert(channel, map);
    }

    /// Replace third-party channel emotes while keeping existing Twitch entries.
    pub fn replace_channel_third_party(
        &mut self,
        channel: &str,
        incoming: std::collections::HashMap<String, EmoteDef>,
    ) {
        let mut next = incoming;
        if let Some(prev) = self.channel.get(channel) {
            for (code, def) in prev {
                if def.provider == "twitch" {
                    next.entry(code.clone()).or_insert_with(|| def.clone());
                }
            }
        }
        self.channel.insert(channel.to_string(), next);
    }

    pub fn drop_channel(&mut self, channel: &str) {
        self.channel.remove(channel);
        self.set_scope.retain(|_, scope| match scope {
            SetScope::Global => true,
            SetScope::Channel(ch) => ch != channel,
        });
    }

    /// Remove all emotes of `provider` from the global map (Twitch globals untouched).
    pub fn purge_global(&mut self, provider: &str) {
        self.global.retain(|_, d| d.provider != provider);
        if provider == "7tv" {
            self.set_scope
                .retain(|_, scope| !matches!(scope, SetScope::Global));
        }
    }

    /// Remove all emotes of `provider` from one channel map.
    pub fn purge_channel(&mut self, channel: &str, provider: &str) {
        if let Some(map) = self.channel.get_mut(channel) {
            map.retain(|_, d| d.provider != provider);
        }
        if provider == "7tv" {
            let scope = SetScope::Channel(channel.to_string());
            self.set_scope.retain(|_, s| s != &scope);
        }
    }

    pub fn clear_channels(&mut self) {
        self.channel.clear();
        self.set_scope
            .retain(|_, scope| matches!(scope, SetScope::Global));
    }

    pub fn lookup(&self, channel: &str, code: &str) -> Option<&EmoteDef> {
        self.channel
            .get(channel)
            .and_then(|m| m.get(code))
            .or_else(|| self.global.get(code))
    }

    pub fn has_channel(&self, channel: &str) -> bool {
        self.channel.contains_key(channel)
    }

    pub fn codes_prefixed(&self, channel: &str, prefix: &str) -> Vec<String> {
        let needle = prefix.to_ascii_lowercase();
        let mut seen = std::collections::HashSet::new();
        let mut out = Vec::new();
        let mut push = |code: &str| {
            if !needle.is_empty() && !code.to_ascii_lowercase().starts_with(&needle) {
                return;
            }
            if seen.insert(code.to_ascii_lowercase()) {
                out.push(code.to_string());
            }
        };
        if let Some(map) = self.channel.get(channel) {
            for code in map.keys() {
                push(code);
            }
        }
        for code in self.global.keys() {
            push(code);
        }
        out
    }

    pub fn bind_set(&mut self, set_id: String, scope: SetScope) {
        match &scope {
            SetScope::Global => {
                self.set_scope.retain(|_, s| !matches!(s, SetScope::Global));
                if !set_id.is_empty() {
                    self.set_scope.insert(set_id, scope);
                }
            }
            SetScope::Channel(_) => {
                self.set_scope.retain(|_, s| s != &scope);
                if set_id.is_empty() {
                    return;
                }
                if matches!(self.set_scope.get(&set_id), Some(SetScope::Global)) {
                    return;
                }
                self.set_scope.insert(set_id, scope);
            }
        }
    }

    pub fn scope_for_set(&self, set_id: &str) -> Option<&SetScope> {
        self.set_scope.get(set_id)
    }

    pub fn upsert_7tv(&mut self, scope: &SetScope, name: String, def: EmoteDef) {
        match scope {
            SetScope::Global => {
                if self.global.get(&name).is_some_and(|d| d.provider != "7tv") {
                    return;
                }
                self.global.insert(name, def);
            }
            SetScope::Channel(channel) => {
                let Some(map) = self.channel.get_mut(channel) else {
                    return;
                };
                if map.get(&name).is_some_and(|d| d.provider != "7tv") {
                    return;
                }
                map.insert(name, def);
            }
        }
    }

    pub fn remove_7tv(&mut self, scope: &SetScope, name: &str) {
        let Some(map) = self.map_mut(scope) else {
            return;
        };
        if map.get(name).is_some_and(|d| d.provider == "7tv") {
            map.remove(name);
        }
    }

    /// BTTV channel emote create/update (by code). Does not overwrite other providers.
    pub fn upsert_bttv(&mut self, channel: &str, code: String, def: EmoteDef) {
        if def.provider != "bttv" {
            return;
        }
        let map = self
            .channel
            .entry(channel.to_string())
            .or_default();
        if map.get(&code).is_some_and(|d| d.provider != "bttv") {
            return;
        }
        let id = def.id.clone();
        map.retain(|c, d| !(d.provider == "bttv" && d.id == id && *c != code));
        map.insert(code, def);
    }

    /// Remove BTTV channel emote by BetterTTV emote id.
    pub fn remove_bttv_by_id(&mut self, channel: &str, emote_id: &str) {
        let Some(map) = self.channel.get_mut(channel) else {
            return;
        };
        map.retain(|_, d| !(d.provider == "bttv" && d.id == emote_id));
    }

    pub fn rename_7tv(&mut self, scope: &SetScope, old: &str, new: String) {
        if old == new {
            return;
        }
        let Some(map) = self.map_mut(scope) else {
            return;
        };
        let Some(def) = map.remove(old) else {
            return;
        };
        if def.provider != "7tv" {
            map.insert(old.to_string(), def);
            return;
        }
        map.insert(new, def);
    }

    pub fn replace_7tv(&mut self, channel: &str, incoming: std::collections::HashMap<String, EmoteDef>) {
        let Some(map) = self.channel.get_mut(channel) else {
            return;
        };
        map.retain(|_, def| def.provider != "7tv");
        map.extend(incoming);
    }

    fn map_mut(&mut self, scope: &SetScope) -> Option<&mut std::collections::HashMap<String, EmoteDef>> {
        match scope {
            SetScope::Global => Some(&mut self.global),
            SetScope::Channel(channel) => self.channel.get_mut(channel),
        }
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

    #[test]
    fn upsert_remove_rename_7tv_on_bound_set() {
        let mut cat = Catalog::default();
        cat.bind_set("set1".into(), SetScope::Channel("xqc".into()));
        cat.replace_channel("xqc".into(), std::collections::HashMap::new());
        cat.upsert_7tv(
            &SetScope::Channel("xqc".into()),
            "cvHazmat".into(),
            def("z", "7tv", true),
        );
        assert!(cat.lookup("xqc", "cvHazmat").is_some());
        cat.rename_7tv(&SetScope::Channel("xqc".into()), "cvHazmat", "cvPaint".into());
        assert!(cat.lookup("xqc", "cvHazmat").is_none());
        assert!(cat.lookup("xqc", "cvPaint").is_some());
        cat.remove_7tv(&SetScope::Channel("xqc".into()), "cvPaint");
        assert!(cat.lookup("xqc", "cvPaint").is_none());
    }

    #[test]
    fn replace_7tv_keeps_bttv() {
        let mut cat = Catalog::default();
        let mut map = std::collections::HashMap::new();
        map.insert("Pog".into(), def("b", "bttv", false));
        map.insert("cvHazmat".into(), def("z", "7tv", true));
        cat.replace_channel("xqc".into(), map);
        let mut incoming = std::collections::HashMap::new();
        incoming.insert("widepeepoHappy".into(), def("n", "7tv", false));
        cat.replace_7tv("xqc", incoming);
        assert!(cat.lookup("xqc", "Pog").is_some());
        assert!(cat.lookup("xqc", "cvHazmat").is_none());
        assert!(cat.lookup("xqc", "widepeepoHappy").is_some());
    }

    #[test]
    fn upsert_channel_without_map_is_noop() {
        let mut cat = Catalog::default();
        cat.bind_set("set1".into(), SetScope::Channel("xqc".into()));
        cat.upsert_7tv(
            &SetScope::Channel("xqc".into()),
            "cvHazmat".into(),
            def("z", "7tv", true),
        );
        assert!(cat.lookup("xqc", "cvHazmat").is_none());
    }

    #[test]
    fn replace_7tv_without_map_is_noop() {
        let mut cat = Catalog::default();
        let mut incoming = std::collections::HashMap::new();
        incoming.insert("widepeepoHappy".into(), def("n", "7tv", false));
        cat.replace_7tv("xqc", incoming);
        assert!(cat.lookup("xqc", "widepeepoHappy").is_none());
    }

    #[test]
    fn bind_set_does_not_clobber_global() {
        let mut cat = Catalog::default();
        cat.bind_set("gid".into(), SetScope::Global);
        cat.bind_set("gid".into(), SetScope::Channel("xqc".into()));
        assert_eq!(cat.scope_for_set("gid"), Some(&SetScope::Global));
        cat.clear_channels();
        assert_eq!(cat.scope_for_set("gid"), Some(&SetScope::Global));
    }

    #[test]
    fn purge_provider_leaves_others() {
        let mut cat = Catalog::default();
        cat.insert_global("Kappa".into(), def("25", "twitch", false));
        cat.insert_global("Wide".into(), def("b", "bttv", false));
        cat.insert_global("Hand".into(), def("f", "ffz", false));
        let mut map = std::collections::HashMap::new();
        map.insert("ChanB".into(), def("cb", "bttv", false));
        map.insert("ChanF".into(), def("cf", "ffz", false));
        cat.replace_channel("xqc".into(), map);
        cat.bind_set("gset".into(), SetScope::Global);
        cat.bind_set("cset".into(), SetScope::Channel("xqc".into()));

        cat.purge_global("bttv");
        assert!(cat.lookup("xqc", "Wide").is_none());
        assert_eq!(
            cat.lookup("xqc", "Kappa").map(|d| d.provider.as_str()),
            Some("twitch")
        );
        assert_eq!(
            cat.lookup("xqc", "Hand").map(|d| d.provider.as_str()),
            Some("ffz")
        );

        cat.purge_channel("xqc", "ffz");
        assert!(cat.lookup("xqc", "ChanF").is_none());
        assert_eq!(
            cat.lookup("xqc", "ChanB").map(|d| d.provider.as_str()),
            Some("bttv")
        );

        cat.purge_global("7tv");
        assert!(cat.scope_for_set("gset").is_none());
        cat.purge_channel("xqc", "7tv");
        assert!(cat.scope_for_set("cset").is_none());
    }

    #[test]
    fn replace_channel_third_party_keeps_twitch() {
        let mut cat = Catalog::default();
        let mut map = std::collections::HashMap::new();
        map.insert("Pog".into(), def("b", "bttv", false));
        map.insert("Kappa".into(), def("25", "twitch", false));
        cat.replace_channel("xqc".into(), map);
        let mut incoming = std::collections::HashMap::new();
        incoming.insert("Hand".into(), def("f", "ffz", false));
        cat.replace_channel_third_party("xqc", incoming);
        assert_eq!(
            cat.lookup("xqc", "Kappa").map(|d| d.provider.as_str()),
            Some("twitch")
        );
        assert_eq!(
            cat.lookup("xqc", "Hand").map(|d| d.provider.as_str()),
            Some("ffz")
        );
        assert!(cat.lookup("xqc", "Pog").is_none());
    }

    #[test]
    fn upsert_does_not_overwrite_bttv() {
        let mut cat = Catalog::default();
        let mut map = std::collections::HashMap::new();
        map.insert("Pog".into(), def("b", "bttv", false));
        cat.replace_channel("xqc".into(), map);
        cat.upsert_7tv(
            &SetScope::Channel("xqc".into()),
            "Pog".into(),
            def("z", "7tv", false),
        );
        assert_eq!(cat.lookup("xqc", "Pog").map(|d| d.provider.as_str()), Some("bttv"));
    }

    #[test]
    fn twitch_vacant_does_not_overwrite_third_party() {
        let mut cat = Catalog::default();
        cat.insert_global("Kappa".into(), def("7", "7tv", false));
        cat.insert_global_vacant("Kappa".into(), def("25", "twitch", false));
        cat.insert_global_vacant("PogChamp".into(), def("88", "twitch", false));
        assert_eq!(
            cat.lookup("xqc", "Kappa").map(|d| d.provider.as_str()),
            Some("7tv")
        );
        assert_eq!(
            cat.lookup("xqc", "PogChamp").map(|d| d.provider.as_str()),
            Some("twitch")
        );
        let mut channel = std::collections::HashMap::new();
        channel.insert("Pog".into(), def("b", "bttv", false));
        cat.replace_channel("xqc".into(), channel);
        let mut twitch = std::collections::HashMap::new();
        twitch.insert("Pog".into(), def("x", "twitch", false));
        twitch.insert("CoolStoryBob".into(), def("y", "twitch", false));
        cat.merge_channel_vacant("xqc", twitch);
        assert_eq!(cat.lookup("xqc", "Pog").map(|d| d.provider.as_str()), Some("bttv"));
        assert_eq!(
            cat.lookup("xqc", "CoolStoryBob").map(|d| d.provider.as_str()),
            Some("twitch")
        );
    }

    #[test]
    fn upsert_bttv_renames_and_skips_other_providers() {
        let mut cat = Catalog::default();
        let mut map = std::collections::HashMap::new();
        map.insert(
            "OldCode".into(),
            EmoteDef {
                id: "eid".into(),
                provider: "bttv".into(),
                url: "https://cdn.betterttv.net/emote/eid/1x".into(),
                zero_width: false,
            },
        );
        map.insert("Pog".into(), def("b", "ffz", false));
        cat.replace_channel("xqc".into(), map);
        cat.upsert_bttv(
            "xqc",
            "NewCode".into(),
            EmoteDef {
                id: "eid".into(),
                provider: "bttv".into(),
                url: "https://cdn.betterttv.net/emote/eid/1x".into(),
                zero_width: false,
            },
        );
        assert!(cat.lookup("xqc", "OldCode").is_none());
        assert_eq!(
            cat.lookup("xqc", "NewCode").map(|d| d.id.as_str()),
            Some("eid")
        );
        cat.upsert_bttv(
            "xqc",
            "Pog".into(),
            EmoteDef {
                id: "x".into(),
                provider: "bttv".into(),
                url: "https://cdn.betterttv.net/emote/x/1x".into(),
                zero_width: false,
            },
        );
        assert_eq!(cat.lookup("xqc", "Pog").map(|d| d.provider.as_str()), Some("ffz"));
        cat.remove_bttv_by_id("xqc", "eid");
        assert!(cat.lookup("xqc", "NewCode").is_none());
        // Rename onto FFZ code must not delete the BTTV id entry.
        cat.upsert_bttv(
            "xqc",
            "KeepMe".into(),
            EmoteDef {
                id: "keep".into(),
                provider: "bttv".into(),
                url: "https://cdn.betterttv.net/emote/keep/1x".into(),
                zero_width: false,
            },
        );
        cat.upsert_bttv(
            "xqc",
            "Pog".into(),
            EmoteDef {
                id: "keep".into(),
                provider: "bttv".into(),
                url: "https://cdn.betterttv.net/emote/keep/1x".into(),
                zero_width: false,
            },
        );
        assert_eq!(
            cat.lookup("xqc", "KeepMe").map(|d| d.id.as_str()),
            Some("keep")
        );
        assert_eq!(cat.lookup("xqc", "Pog").map(|d| d.provider.as_str()), Some("ffz"));
    }

    #[test]
    fn bump_load_rejects_stale_generation() {
        let mut cat = Catalog::default();
        let first = cat.bump_load();
        let second = cat.bump_load();
        assert_ne!(first, second);
        assert_eq!(cat.load_gen(), second);
        let mut stale = std::collections::HashMap::new();
        stale.insert("Kappa".into(), def("25", "twitch", false));
        if cat.load_gen() == first {
            cat.replace_channel("xqc".into(), stale);
        }
        assert!(cat.lookup("xqc", "Kappa").is_none());
    }
}

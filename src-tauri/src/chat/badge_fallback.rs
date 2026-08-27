//! Offline global Twitch badge URLs for anonymous IRC (Helix needs OAuth).
//! UUID paths from public `static-cdn.jtvnw.net` (Twitch CDN), not Chatterino assets.

use super::helix::{BadgeCatalog, BadgeMap};

const CDN: &str = "https://static-cdn.jtvnw.net/badges/v1";

/// Seed global catalog when Helix is unavailable (no token / Helix fail).
pub fn seed_global(catalog: &mut BadgeCatalog) {
    if !catalog.global_is_empty() {
        return;
    }
    catalog.replace_global(essential_global_map());
}

fn essential_global_map() -> BadgeMap {
    let mut map = BadgeMap::new();
    for (set, version, uuid) in ESSENTIAL {
        map.insert(
            format!("{set}/{version}"),
            format!("{CDN}/{uuid}/1"),
        );
    }
    map
}

/// Core IRC badge sets viewers see without channel Helix overrides.
const ESSENTIAL: &[(&str, &str, &str)] = &[
    ("admin", "1", "9ef7e029-4cdf-4d4d-a0d5-e2b3fb2583fe"),
    ("broadcaster", "1", "5527c58c-fb7d-422d-b71b-f309dcb85cc1"),
    ("global_mod", "1", "9384c43e-4ce7-4e94-b2a1-b93656896eba"),
    ("moderator", "1", "3267646d-33f0-4b17-b3df-f923a41db1d0"),
    ("staff", "1", "d97c37bd-a6f5-4c38-8f57-4e4bef88af34"),
    ("vip", "1", "b817aba4-fad8-49e2-b88a-7cc744dfa6ec"),
    ("partner", "1", "d12a2e27-16f6-41d0-ab77-b780518f00a3"),
    ("turbo", "1", "bd444ec6-8f34-4bf9-91f4-af1e3428d80f"),
    ("premium", "1", "bbbe0db0-a598-423e-86d0-f9fb98ca1933"),
    ("founder", "0", "511b78a9-ab37-472f-9569-457753bbe7d3"),
    ("founder", "1", "511b78a9-ab37-472f-9569-457753bbe7d3"),
    ("artist-badge", "1", "4300a897-03dc-4e83-8c0e-c332fee7057f"),
    ("no_audio", "1", "aef2cd08-f29b-45a1-8c12-d44d7fd5e6f0"),
    ("no_video", "1", "199a0dba-58f3-494e-a7fc-1fa0a1001fb8"),
    ("glhf-pledge", "1", "3158e758-3cb4-43c5-94b3-7639810451c5"),
    ("hype-train", "1", "fae4086c-3190-44d4-83c8-8ef0cbe1a515"),
    ("hype-train", "2", "9c8d038a-3a29-45ea-96d4-5031fb1a7a81"),
    ("lead_moderator", "1", "0822047b-65e0-46f2-94a9-d1091d685d33"),
    ("twitchbot", "1", "df9095f6-a8a0-4cc2-bb33-d908c0adffb8"),
    ("subscriber", "0", "5d9f2208-5dd8-11e7-8513-2ff4adfae661"),
    ("subscriber", "1", "5d9f2208-5dd8-11e7-8513-2ff4adfae661"),
    ("subscriber", "2", "25a03e36-2bb2-4625-bd37-d6d9d406238d"),
    ("subscriber", "3", "e8984705-d091-4e54-8241-e53b30a84b0e"),
    ("subscriber", "4", "2d2485f6-d19b-4daa-8393-9493b019156b"),
    ("subscriber", "5", "b4e6b13a-a76f-4c56-87e1-9375a7aaa610"),
    ("subscriber", "6", "ed51a614-2c44-4a60-80b6-62908436b43a"),
    ("bits", "1", "73b5c3fb-24f9-4a82-a852-2f475b59411c"),
    ("bits", "100", "09d93036-e7ce-431c-9a9e-7044297133f2"),
    ("bits", "1000", "0d85a29e-79ad-4c63-a285-3acd2c66f2ba"),
    ("bits", "5000", "57cd97fc-3e9e-4c6d-9d41-60147137234e"),
    ("bits", "10000", "68af213b-a771-4124-b6e3-9bb6d98aa732"),
    ("bits", "25000", "64ca5920-c663-4bd8-bfb1-751b4caea2dd"),
    ("bits", "50000", "62310ba7-9916-4235-9eba-40110d67f85d"),
    ("bits", "75000", "ce491fa4-b24f-4f3b-b6ff-44b080202792"),
    ("bits", "100000", "96f0540f-aa63-49e1-a8b3-259ece3bd098"),
    ("bits-leader", "1", "8bedf8c3-7a6d-4df2-b62f-791b96a5dd31"),
    ("bits-leader", "2", "f04baac7-9141-4456-a0e7-6301bcc34138"),
    ("bits-leader", "3", "f1d2aab6-b647-47af-965b-84909cf303aa"),
    ("sub-gifter", "1", "a5ef6c17-2e5b-4d8f-9b80-2779fd722414"),
    ("sub-gifter", "5", "ee113e59-c839-4472-969a-1e16d20f3962"),
    ("sub-gifter", "10", "d333288c-65d7-4c7b-b691-cdd7b3484bf8"),
    ("sub-gifter", "25", "052a5d41-f1cc-455c-bc7b-fe841ffaf17f"),
    ("sub-gifter", "50", "c4a29737-e8a5-4420-917a-314a447f083e"),
    ("sub-gifter", "100", "8343ada7-3451-434e-91c4-e82bdcf54460"),
    ("sub-gift-leader", "1", "21656088-7da2-4467-acd2-55220e1f45ad"),
    ("sub-gift-leader", "2", "0d9fe96b-97b7-4215-b5f3-5328ebad271c"),
    ("sub-gift-leader", "3", "4c6e4497-eed9-4dd3-ac64-e0599d0a63e5"),
    ("predictions", "blue-1", "e33d8b46-f63b-4e67-996d-4a7dcec0ad33"),
    ("predictions", "pink-1", "75e27613-caf7-4585-98f1-cb7363a69a4a"),
    ("predictions", "gray-1", "144f77a2-e324-4a6b-9c17-9304fa193a27"),
];

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::helix::allowed_badge_url;

    #[test]
    fn seed_fills_moderator_and_urls_are_allowed() {
        let mut cat = BadgeCatalog::default();
        seed_global(&mut cat);
        let url = cat
            .lookup("any", "moderator", "1")
            .expect("mod")
            .to_string();
        assert!(allowed_badge_url(&url).is_some());
        assert!(url.ends_with("/1"));
        seed_global(&mut cat);
        assert_eq!(cat.lookup("any", "moderator", "1"), Some(url.as_str()));
    }
}

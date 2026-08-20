// Tab completion kinds follow Chatterino TabCompletionModel (MIT).
// Defaults: prefixOnlyEmoteCompletion=true, userCompletionOnlyWithAt=false.
// No C++/Qt copied.

pub const COMPLETE_LIMIT: usize = 200;
pub const MIN_QUERY: usize = 2;
const USER_RESERVE: usize = 32;

pub fn suggestions(
    token: &str,
    first_word: bool,
    mut emote_codes: Vec<String>,
    mut chatter_names: Vec<String>,
) -> Vec<String> {
    if token.chars().count() < MIN_QUERY {
        return Vec::new();
    }
    if token
        .chars()
        .any(|c| matches!(c, '\0' | '\r' | '\n' | '\u{0001}'))
    {
        return Vec::new();
    }
    if first_word && (token.starts_with('/') || token.starts_with('.')) {
        return command_items(token);
    }
    let with_at = token.starts_with('@');
    rank_prefix(&mut emote_codes, token);
    rank_prefix(&mut chatter_names, token);
    let mut out = Vec::new();
    if !with_at {
        let user_room = chatter_names.len().min(USER_RESERVE).min(COMPLETE_LIMIT);
        let emote_cap = COMPLETE_LIMIT.saturating_sub(user_room);
        for code in emote_codes.into_iter().take(emote_cap) {
            out.push(format!("{code} "));
        }
    }
    for name in chatter_names {
        let item = if with_at {
            format!("@{name} ")
        } else {
            format!("{name} ")
        };
        if out.iter().any(|x| x == &item) {
            continue;
        }
        out.push(item);
        if out.len() >= COMPLETE_LIMIT {
            break;
        }
    }
    out
}

pub fn rank_prefix(items: &mut Vec<String>, prefix: &str) {
    let needle = prefix.strip_prefix('@').unwrap_or(prefix);
    items.sort_by(|a, b| a.to_ascii_lowercase().cmp(&b.to_ascii_lowercase()));
    if needle.is_empty() {
        return;
    }
    if let Some(i) = items
        .iter()
        .position(|n| n.eq_ignore_ascii_case(needle))
    {
        let exact = items.remove(i);
        items.insert(0, exact);
    }
}

fn command_items(token: &str) -> Vec<String> {
    let rest = token.get(1..).unwrap_or("");
    if "me".starts_with(&rest.to_ascii_lowercase()) {
        vec!["/me ".into()]
    } else {
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_query_empty() {
        assert!(suggestions("K", true, vec![], vec![]).is_empty());
    }

    #[test]
    fn me_command() {
        assert_eq!(
            suggestions("/m", true, vec![], vec![]),
            vec!["/me ".to_string()]
        );
        assert!(suggestions("/m", false, vec![], vec![]).is_empty());
        assert!(suggestions("/ban", true, vec![], vec![]).is_empty());
    }

    #[test]
    fn emote_prefix_and_at_users() {
        let emotes = vec!["Kappa".to_string()];
        let users = vec!["Kapper".to_string()];
        assert_eq!(
            suggestions("Ka", false, emotes.clone(), users.clone()),
            vec!["Kappa ".to_string(), "Kapper ".to_string()]
        );
        assert_eq!(
            suggestions("@ka", false, emotes, users),
            vec!["@Kapper ".to_string()]
        );
    }

    #[test]
    fn reserves_user_slots_when_emotes_flood() {
        let emotes: Vec<String> = (0..COMPLETE_LIMIT)
            .map(|i| format!("aa{i}"))
            .collect();
        let users = vec!["aardvark".to_string()];
        let out = suggestions("aa", false, emotes, users);
        assert_eq!(out.len(), COMPLETE_LIMIT);
        assert!(out.iter().any(|s| s == "aardvark "));
        assert!(out.iter().any(|s| s.starts_with("aa")));
    }
}

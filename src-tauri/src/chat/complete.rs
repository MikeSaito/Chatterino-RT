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
    suggestions_with_rank(token, first_word, emote_codes, chatter_names, true)
}

pub fn suggestions_with_rank(
    token: &str,
    first_word: bool,
    mut emote_codes: Vec<String>,
    mut chatter_names: Vec<String>,
    rank_emotes: bool,
) -> Vec<String> {
    if token.chars().count() < MIN_QUERY && token != ":" {
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
    let colon_emote = token.starts_with(':');
    if rank_emotes {
        rank_prefix(&mut emote_codes, token);
    }
    rank_prefix(&mut chatter_names, token);
    let mut out = Vec::new();
    if !with_at {
        let user_room = if colon_emote {
            0
        } else {
            chatter_names.len().min(USER_RESERVE).min(COMPLETE_LIMIT)
        };
        let emote_cap = COMPLETE_LIMIT.saturating_sub(user_room);
        for code in emote_codes.into_iter().take(emote_cap) {
            out.push(format!("{code} "));
        }
    }
    if !colon_emote {
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
    }
    out
}

/// Leading `:` → emote query needle (stock TabCompletionModel / SplitInput).
/// Lone `:` → `Some("")` (match all emotes, capped by caller).
pub fn colon_emote_needle(token: &str) -> Option<&str> {
    token.strip_prefix(':')
}

/// Stock SmartEmoteStrategy / SmartTabEmoteStrategy (MIT reimpl).
/// `contains`: true = popup colon path; false = Tab prefix-only path.
pub fn apply_smart_emotes(
    query_needle: &str,
    codes: Vec<String>,
    contains: bool,
    ignore_colon_for_cost: bool,
    ignore_tilde_for_cost: bool,
) -> Vec<String> {
    if codes.is_empty() {
        return codes;
    }
    let have_upper = query_needle.chars().any(|c| c.is_uppercase());
    let matches = |code: &str, case_sensitive: bool| -> bool {
        if query_needle.is_empty() {
            return true;
        }
        smart_needle_match(code, query_needle, contains, case_sensitive)
    };
    let mut matched: Vec<String> = codes
        .iter()
        .filter(|c| matches(c, have_upper))
        .cloned()
        .collect();
    let prioritize_upper;
    if matched.is_empty() {
        if !have_upper {
            return Vec::new();
        }
        matched = codes
            .into_iter()
            .filter(|c| matches(&c, false))
            .collect();
        if matched.is_empty() {
            return matched;
        }
        prioritize_upper = true;
    } else {
        prioritize_upper = false;
    }
    smart_emote_rank(
        query_needle,
        &mut matched,
        prioritize_upper,
        ignore_colon_for_cost,
        ignore_tilde_for_cost,
    );
    matched
}

fn smart_needle_match(code: &str, needle: &str, contains: bool, case_sensitive: bool) -> bool {
    if case_sensitive {
        if contains {
            code.contains(needle)
        } else {
            code.starts_with(needle)
        }
    } else {
        let code_l = code.to_ascii_lowercase();
        let needle_l = needle.to_ascii_lowercase();
        if contains {
            code_l.contains(&needle_l)
        } else {
            code_l.starts_with(&needle_l)
        }
    }
}

fn strip_for_cost<'a>(emote: &'a str, ignore_colon: bool, ignore_tilde: bool) -> &'a str {
    let mut s = emote;
    if ignore_colon {
        s = s.strip_prefix(':').unwrap_or(s);
    }
    if ignore_tilde {
        s = s.strip_prefix('~').unwrap_or(s);
    }
    s
}

fn cost_of_emote(query: &str, emote: &str, prioritize_upper: bool) -> i32 {
    let mut score: i32 = 0;
    if prioritize_upper {
        for c in emote.chars() {
            if !c.is_uppercase() {
                score += 1;
            }
        }
    } else {
        for (qc, ec) in query.chars().zip(emote.chars()) {
            if qc.is_uppercase() != ec.is_uppercase() {
                score += 1;
            }
        }
    }
    if score == 0 {
        score = -10;
    }
    let q_len = query.chars().count() as i32;
    let e_len = emote.chars().count() as i32;
    let diff = e_len - q_len;
    if diff > 0 {
        score += diff * 100;
    }
    score
}

fn smart_emote_rank(
    query: &str,
    codes: &mut [String],
    prioritize_upper: bool,
    ignore_colon: bool,
    ignore_tilde: bool,
) {
    codes.sort_by(|a, b| {
        let sa = strip_for_cost(a, ignore_colon, ignore_tilde);
        let sb = strip_for_cost(b, ignore_colon, ignore_tilde);
        let cost_a = cost_of_emote(query, sa, prioritize_upper);
        let cost_b = cost_of_emote(query, sb, prioritize_upper);
        if cost_a != cost_b {
            return cost_a.cmp(&cost_b);
        }
        sa.to_ascii_lowercase().cmp(&sb.to_ascii_lowercase())
    });
}

pub fn rank_prefix(items: &mut Vec<String>, prefix: &str) {
    let needle = prefix
        .strip_prefix('@')
        .or_else(|| prefix.strip_prefix(':'))
        .unwrap_or(prefix);
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

const COMMANDS: &[&str] = &[
    "me",
    "ban",
    "unban",
    "timeout",
    "untimeout",
    "delete",
    "clear",
    "slow",
    "slowoff",
    "followers",
    "followersoff",
    "subscribers",
    "subscribersoff",
    "emoteonly",
    "emoteonlyoff",
    "uniquechat",
    "uniquechatoff",
    "r9kbeta",
    "r9kbetaoff",
    "mods",
    "vips",
    "mod",
    "unmod",
    "vip",
    "unvip",
    "commercial",
    "raid",
    "unraid",
    "marker",
    "color",
    "block",
    "unblock",
    "w",
];

pub fn is_known_command(name: &str) -> bool {
    let needle = name.to_ascii_lowercase();
    COMMANDS.iter().any(|c| *c == needle)
}

fn command_items(token: &str) -> Vec<String> {
    let rest = token.get(1..).unwrap_or("").to_ascii_lowercase();
    let mut out = Vec::new();
    for cmd in COMMANDS {
        if cmd.starts_with(rest.as_str()) {
            out.push(format!("/{cmd} "));
            if out.len() >= COMPLETE_LIMIT {
                break;
            }
        }
    }
    out
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
            vec![
                "/me ".to_string(),
                "/mods ".to_string(),
                "/mod ".to_string(),
                "/marker ".to_string()
            ]
        );
        assert!(suggestions("/m", false, vec![], vec![]).is_empty());
        assert_eq!(
            suggestions("/ban", true, vec![], vec![]),
            vec!["/ban ".to_string()]
        );
        assert!(is_known_command("timeout"));
        assert!(!is_known_command("nope"));
    }

    #[test]
    fn emotes_only_when_no_users() {
        let emotes = vec!["Kappa".to_string()];
        assert_eq!(
            suggestions("Ka", false, emotes, Vec::new()),
            vec!["Kappa ".to_string()]
        );
    }

    #[test]
    fn at_only_users_without_emotes() {
        let users = vec!["Kapper".to_string()];
        assert_eq!(
            suggestions("@ka", false, Vec::new(), users),
            vec!["@Kapper ".to_string()]
        );
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

    #[test]
    fn colon_emote_needle_and_suggestions() {
        assert_eq!(colon_emote_needle(":Ka"), Some("Ka"));
        assert_eq!(colon_emote_needle(":"), Some(""));
        assert_eq!(colon_emote_needle("Ka"), None);
        let out = suggestions(":Ka", false, vec!["Kappa".to_string()], Vec::new());
        assert_eq!(out, vec!["Kappa ".to_string()]);
        let no_users = suggestions(
            ":Ka",
            false,
            vec!["Kappa".to_string()],
            vec!["Kapper".to_string()],
        );
        assert_eq!(no_users, vec!["Kappa ".to_string()]);
    }

    #[test]
    fn smart_contains_and_cost_order() {
        let codes = vec![
            "xxKappa".to_string(),
            "Kappa".to_string(),
            "KappaPride".to_string(),
        ];
        let ranked = apply_smart_emotes("Kappa", codes, true, true, false);
        assert_eq!(ranked.first().map(String::as_str), Some("Kappa"));
        assert!(ranked.iter().any(|c| c == "xxKappa"));
        assert!(ranked.iter().any(|c| c == "KappaPride"));
        assert!(
            ranked.iter().position(|c| c == "Kappa").unwrap()
                < ranked.iter().position(|c| c == "KappaPride").unwrap()
        );
        let empty_q = apply_smart_emotes(
            "",
            vec!["LongName".into(), "Ab".into(), "Mid".into()],
            true,
            true,
            false,
        );
        assert_eq!(empty_q.first().map(String::as_str), Some("Ab"));
        let colon_code = apply_smart_emotes(
            ")",
            vec![":)".into(), "Kappa".into()],
            true,
            true,
            false,
        );
        assert_eq!(colon_code.first().map(String::as_str), Some(":)"));
    }

    #[test]
    fn smart_uppercase_prefers_case_match() {
        let codes = vec!["pajaW".to_string(), "PAJAW".to_string()];
        let ranked = apply_smart_emotes("PA", codes, false, false, false);
        assert_eq!(ranked, vec!["PAJAW".to_string()]);
    }

    #[test]
    fn smart_preserves_order_in_suggestions_with_rank_false() {
        let emotes = vec!["B".to_string(), "A".to_string()];
        let out = suggestions_with_rank("ab", false, emotes, Vec::new(), false);
        assert_eq!(out, vec!["B ".to_string(), "A ".to_string()]);
    }
}

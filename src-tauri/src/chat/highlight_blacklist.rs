// MIT reimpl: Chatterino UserInfoPopup ignore highlights → highlight_blacklist settings.

use serde::Serialize;

use super::filters::{login_is_blacklisted, BlacklistRule};
use super::settings::{self, HighlightBlacklistRow};
use super::state::Shared;

const MAX_TABLE_ROWS: usize = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IgnoreHighlightsState {
    pub ignored: bool,
    pub regex_locked: bool,
}

fn validate_login(raw: &str) -> Result<String, String> {
    let login = raw.trim().to_ascii_lowercase();
    if login.is_empty()
        || login.len() > 25
        || !login
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_')
    {
        return Err("invalid login".into());
    }
    Ok(login)
}

fn has_exact_row(rows: &[HighlightBlacklistRow], login: &str) -> bool {
    rows.iter().any(|row| {
        !row.regex && row.username.trim().eq_ignore_ascii_case(login)
    })
}

fn has_exact_rule(rules: &[BlacklistRule], login: &str) -> bool {
    rules.iter().any(|rule| {
        !rule.is_regex && rule.pattern.trim().eq_ignore_ascii_case(login)
    })
}

fn state_from_rules(rules: &[BlacklistRule], login: &str) -> IgnoreHighlightsState {
    let ignored = has_exact_rule(rules, login);
    let regex_locked = login_is_blacklisted(login, rules) && !ignored;
    IgnoreHighlightsState {
        ignored,
        regex_locked,
    }
}

pub fn query_state(shared: &Shared, login: &str) -> Result<IgnoreHighlightsState, String> {
    let login = validate_login(login)?;
    let rules = shared
        .highlight_blacklist
        .lock()
        .map_err(|_| "lock".to_string())?
        .clone();
    Ok(state_from_rules(&rules, &login))
}

pub fn set_user_ignore_highlights(
    shared: &Shared,
    login: &str,
    ignored: bool,
) -> Result<(), String> {
    let login = validate_login(login)?;
    settings::mutate_highlight_blacklist(shared, |rows| {
        if ignored {
            if has_exact_row(rows, &login) {
                return Ok(());
            }
            if rows.len() >= MAX_TABLE_ROWS {
                return Err("highlight blacklist limit reached".into());
            }
            rows.push(HighlightBlacklistRow {
                username: login.clone(),
                regex: false,
            });
        } else {
            rows.retain(|row| row.regex || !row.username.trim().eq_ignore_ascii_case(&login));
        }
        Ok(())
    })
    .map_err(|e| e.message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::settings::HighlightBlacklistRow;

    #[test]
    fn exact_row_detection() {
        let rows = vec![HighlightBlacklistRow {
            username: "NightBot".into(),
            regex: false,
        }];
        assert!(has_exact_row(&rows, "nightbot"));
        assert!(!has_exact_row(&rows, "other"));
    }

    #[test]
    fn state_ignored_when_exact_row() {
        let rules = blacklist_rules_from_settings(&crate::chat::settings::AppSettings {
            highlight_blacklist: vec![HighlightBlacklistRow {
                username: "ann".into(),
                regex: false,
            }],
            ..Default::default()
        });
        let state = state_from_rules(&rules, "Ann");
        assert!(state.ignored);
        assert!(!state.regex_locked);
    }

    #[test]
    fn state_regex_locked_without_exact_row() {
        let rules = blacklist_rules_from_settings(&crate::chat::settings::AppSettings {
            highlight_blacklist: vec![HighlightBlacklistRow {
                username: r"^bot_.*".into(),
                regex: true,
            }],
            ..Default::default()
        });
        assert!(login_is_blacklisted("bot_xyz", &rules));
        let state = state_from_rules(&rules, "bot_xyz");
        assert!(!state.ignored);
        assert!(state.regex_locked);
    }

    #[test]
    fn uncheck_leaves_regex_lock_state() {
        let mut rows = vec![
            HighlightBlacklistRow {
                username: "bot_xyz".into(),
                regex: false,
            },
            HighlightBlacklistRow {
                username: r"^bot_.*".into(),
                regex: true,
            },
        ];
        rows.retain(|row| row.regex || !row.username.trim().eq_ignore_ascii_case("bot_xyz"));
        assert_eq!(rows.len(), 1);
        let rules = blacklist_rules_from_settings(&crate::chat::settings::AppSettings {
            highlight_blacklist: rows,
            ..Default::default()
        });
        let state = state_from_rules(&rules, "bot_xyz");
        assert!(!state.ignored);
        assert!(state.regex_locked);
    }

    #[test]
    fn validate_login_rejects_invalid() {
        assert!(validate_login("").is_err());
        assert!(validate_login("bad name").is_err());
        assert!(validate_login("valid_user").is_ok());
    }
}

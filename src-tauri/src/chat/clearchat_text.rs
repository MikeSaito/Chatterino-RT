//! English CLEARCHAT display text (search hits, chat logs).
//! Shared-chat suffix mirrors Chatterino EventSub MessageHandlers (MIT reimpl).

use super::usernotice::format_duration_en;

/// Format CLEARCHAT for UI/search/log: cleared, timeout, ban, optional shared source + stack.
pub fn clearchat_text_en(
    login: Option<&str>,
    duration_sec: Option<u64>,
    stack_count: u32,
    source_login: Option<&str>,
    moderator_login: Option<&str>,
) -> String {
    let source = source_login.filter(|s| !s.is_empty());
    let moderator = moderator_login.filter(|s| !s.is_empty());
    let mut text = match (login, duration_sec, source, moderator) {
        (None, _, _, _) => "Chat cleared".to_string(),
        (Some(login), Some(sec), Some(src), Some(mod_login)) => format!(
            "{mod_login} timed out {login} for {} in {src}.",
            format_duration_en(sec, 4)
        ),
        (Some(login), None, Some(src), Some(mod_login)) => {
            format!("{mod_login} banned {login} in {src}.")
        }
        (Some(login), Some(sec), Some(src), None) => {
            format!(
                "{login} timed out for {} in {src}",
                format_duration_en(sec, 4)
            )
        }
        (Some(login), None, Some(src), None) => format!("{login} was banned in {src}"),
        (Some(login), Some(sec), None, _) => {
            format!("{login} timed out for {}", format_duration_en(sec, 4))
        }
        (Some(login), None, None, _) => format!("{login} was banned"),
    };
    if stack_count > 1 {
        text.push_str(&format!(" ({stack_count} times)"));
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleared_timeout_ban_stack() {
        assert_eq!(clearchat_text_en(None, None, 1, None, None), "Chat cleared");
        assert_eq!(
            clearchat_text_en(Some("bob"), Some(60), 1, None, None),
            "bob timed out for 1m"
        );
        assert_eq!(
            clearchat_text_en(Some("bob"), None, 1, None, None),
            "bob was banned"
        );
        assert_eq!(
            clearchat_text_en(Some("dev"), Some(60), 3, None, None),
            "dev timed out for 1m (3 times)"
        );
        assert_eq!(
            clearchat_text_en(Some("x"), Some(3661), 1, None, None),
            "x timed out for 1h 1m 1s"
        );
    }

    #[test]
    fn shared_ban_and_timeout() {
        assert_eq!(
            clearchat_text_en(Some("bob"), None, 1, Some("src"), Some("mod")),
            "mod banned bob in src."
        );
        assert_eq!(
            clearchat_text_en(Some("bob"), Some(60), 1, Some("src"), Some("mod")),
            "mod timed out bob for 1m in src."
        );
        assert_eq!(
            clearchat_text_en(Some("bob"), None, 1, Some("src"), None),
            "bob was banned in src"
        );
    }
}

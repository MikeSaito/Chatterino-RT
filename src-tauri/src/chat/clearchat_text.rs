//! English CLEARCHAT display text (search hits, chat logs).

use super::usernotice::format_duration_en;

/// Format CLEARCHAT for UI/search/log: cleared, timeout, ban, optional stack.
pub fn clearchat_text_en(
    login: Option<&str>,
    duration_sec: Option<u64>,
    stack_count: u32,
) -> String {
    let mut text = match (login, duration_sec) {
        (None, _) => "Chat cleared".to_string(),
        (Some(login), Some(sec)) => {
            format!("{login} timed out for {}", format_duration_en(sec, 4))
        }
        (Some(login), None) => format!("{login} was banned"),
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
        assert_eq!(clearchat_text_en(None, None, 1), "Chat cleared");
        assert_eq!(
            clearchat_text_en(Some("bob"), Some(60), 1),
            "bob timed out for 1m"
        );
        assert_eq!(clearchat_text_en(Some("bob"), None, 1), "bob was banned");
        assert_eq!(
            clearchat_text_en(Some("dev"), Some(60), 3),
            "dev timed out for 1m (3 times)"
        );
        assert_eq!(
            clearchat_text_en(Some("x"), Some(3661), 1),
            "x timed out for 1h 1m 1s"
        );
    }
}

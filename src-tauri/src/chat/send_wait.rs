//! Send-wait countdown (Chatterino TwitchChannel setSendWait / FormatTime short).
//! MIT logic; no C++/Qt.

use std::time::{Duration, Instant};

use super::types::{Badge, ChatEvent};

/// Short duration like stock `formatTime(secs, 2)`: `5s`, `1m 30s`, `2h 5m`.
pub fn format_short_duration(total_seconds: u64, max_parts: u32) -> String {
    if total_seconds == 0 || max_parts == 0 {
        return String::new();
    }
    let mut components = max_parts;
    let seconds = (total_seconds % 60) as u32;
    let timeout_minutes = total_seconds / 60;
    let minutes = (timeout_minutes % 60) as u32;
    let timeout_hours = timeout_minutes / 60;
    let hours = (timeout_hours % 24) as u32;
    let days = (timeout_hours / 24) as u32;
    let mut out = String::new();
    if days > 0 && components > 0 {
        append_part(&mut out, days, 'd');
        components -= 1;
    }
    if hours > 0 && components > 0 {
        append_part(&mut out, hours, 'h');
        components -= 1;
    }
    if minutes > 0 && components > 0 {
        append_part(&mut out, minutes, 'm');
        components -= 1;
    }
    if seconds > 0 && components > 0 {
        append_part(&mut out, seconds, 's');
    }
    out
}

fn append_part(out: &mut String, count: u32, suffix: char) {
    if !out.is_empty() {
        out.push(' ');
    }
    out.push_str(&count.to_string());
    out.push(suffix);
}

pub fn has_high_rate_limit(badges: &[Badge]) -> bool {
    badges.iter().any(|b| {
        matches!(
            b.set.as_str(),
            "moderator" | "lead_moderator" | "vip" | "broadcaster"
        )
    })
}

/// Seconds from NOTICE `msg_slowmode` / `msg_timedout` English text (stock word index).
pub fn seconds_from_notice(msg_id: &str, text: &str) -> Option<u32> {
    let idx = if msg_id.eq_ignore_ascii_case("msg_slowmode") {
        21usize
    } else if msg_id.eq_ignore_ascii_case("msg_timedout") {
        5usize
    } else {
        return None;
    };
    let word = text.split(' ').nth(idx)?;
    word.parse().ok()
}

#[derive(Debug, Default)]
pub struct SendWait {
    end: Option<Instant>,
    last_emitted: Option<String>,
}

impl SendWait {
    pub fn set(&mut self, seconds: u32) {
        if seconds == 0 {
            self.end = None;
            return;
        }
        self.end = Some(Instant::now() + Duration::from_secs(u64::from(seconds)));
    }

    pub fn clear(&mut self) {
        self.end = None;
    }

    pub fn remaining_secs(&self) -> u64 {
        let Some(end) = self.end else {
            return 0;
        };
        end.saturating_duration_since(Instant::now()).as_secs()
    }

    pub fn current_text(&self) -> String {
        let rem = self.remaining_secs();
        if rem == 0 {
            String::new()
        } else {
            format_short_duration(rem, 2)
        }
    }

    /// When text changed (including clear after a wait), return new text for emit.
    pub fn poll_emit(&mut self) -> Option<String> {
        let text = self.current_text();
        if text.is_empty() {
            self.end = None;
        }
        let changed = match &self.last_emitted {
            None => !text.is_empty(),
            Some(prev) => prev != &text,
        };
        if !changed {
            return None;
        }
        self.last_emitted = Some(text.clone());
        Some(text)
    }

    /// Buffer dropped: clear and emit empty if a non-empty label was shown.
    pub fn clear_for_drop(&mut self) -> Option<String> {
        let shown = self
            .last_emitted
            .as_ref()
            .is_some_and(|t| !t.is_empty())
            || self.end.is_some();
        self.end = None;
        if !shown {
            return None;
        }
        self.last_emitted = Some(String::new());
        Some(String::new())
    }
}

/// Apply stock send-wait triggers for one event. `slow_sec` is current room mode.
pub fn apply_event(
    wait: &mut SendWait,
    event: &ChatEvent,
    self_login: Option<&str>,
    slow_sec: u32,
) {
    let Some(me) = self_login.filter(|s| !s.is_empty()) else {
        return;
    };
    match event {
        ChatEvent::Privmsg {
            login, badges, ..
        } => {
            if !login.eq_ignore_ascii_case(me) {
                return;
            }
            wait.clear();
            if !has_high_rate_limit(badges) && slow_sec > 0 {
                wait.set(slow_sec);
            }
        }
        ChatEvent::Clearchat {
            target_login,
            duration_sec,
            ..
        } => {
            let Some(target) = target_login.as_deref() else {
                return;
            };
            if !target.eq_ignore_ascii_case(me) {
                return;
            }
            if let Some(secs) = *duration_sec {
                if secs > 0 {
                    wait.set(secs);
                }
            }
        }
        ChatEvent::Notice { id, text, .. } => {
            if let Some(secs) = seconds_from_notice(id, text) {
                if secs > 0 {
                    wait.set(secs);
                }
            }
        }
        _ => {}
    }
}

/// Client-side send rate limit (Chatterino TwitchIrcServer::prepareToSend). MIT reimpl.
#[derive(Default)]
pub struct SendRateState {
    pleb: std::collections::VecDeque<std::time::Instant>,
    mod_times: std::collections::VecDeque<std::time::Instant>,
    last_error_speed: Option<std::time::Instant>,
    last_error_amount: Option<std::time::Instant>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrepareSend {
    Ok,
    Notice(&'static str),
    Blocked,
}

impl SendRateState {
    pub fn prepare(&mut self, high_rate: bool) -> PrepareSend {
        use std::time::{Duration, Instant};
        const PLEB_GAP: Duration = Duration::from_millis(1100);
        const MOD_GAP: Duration = Duration::from_millis(100);
        const WINDOW: Duration = Duration::from_secs(32);
        const PLEB_MAX: usize = 19;
        const MOD_MAX: usize = 99;
        const ERROR_COOLDOWN: Duration = Duration::from_secs(30);

        let now = Instant::now();
        let (queue, max, gap) = if high_rate {
            (&mut self.mod_times, MOD_MAX, MOD_GAP)
        } else {
            (&mut self.pleb, PLEB_MAX, PLEB_GAP)
        };
        while queue.front().is_some_and(|t| *t + WINDOW < now) {
            queue.pop_front();
        }
        if queue.back().is_some_and(|t| *t + gap > now) {
            if self
                .last_error_speed
                .is_none_or(|t| t + ERROR_COOLDOWN < now)
            {
                self.last_error_speed = Some(now);
                return PrepareSend::Notice("You are sending messages too quickly.");
            }
            return PrepareSend::Blocked;
        }
        if queue.len() >= max {
            if self
                .last_error_amount
                .is_none_or(|t| t + ERROR_COOLDOWN < now)
            {
                self.last_error_amount = Some(now);
                return PrepareSend::Notice("You are sending too many messages.");
            }
            return PrepareSend::Blocked;
        }
        queue.push_back(now);
        PrepareSend::Ok
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_two_parts() {
        assert_eq!(format_short_duration(5, 2), "5s");
        assert_eq!(format_short_duration(90, 2), "1m 30s");
        assert_eq!(format_short_duration(3725, 2), "1h 2m");
        assert_eq!(format_short_duration(90_000, 2), "1d 1h");
        assert_eq!(format_short_duration(0, 2), "");
    }

    #[test]
    fn notice_word_indices() {
        let slow = "This room is in slow mode and you are sending messages too quickly. You will be able to talk again in 10 seconds.";
        assert_eq!(seconds_from_notice("msg_slowmode", slow), Some(10));
        let to = "You are timed out for 3600 more seconds.";
        assert_eq!(seconds_from_notice("msg_timedout", to), Some(3600));
        assert_eq!(seconds_from_notice("other", slow), None);
    }

    #[test]
    fn high_rate_badges() {
        assert!(has_high_rate_limit(&[Badge {
            set: "moderator".into(),
            version: "1".into(),
            url: None,
        }]));
        assert!(!has_high_rate_limit(&[Badge {
            set: "subscriber".into(),
            version: "1".into(),
            url: None,
        }]));
    }

    #[test]
    fn poll_emit_changes() {
        let mut w = SendWait::default();
        assert!(w.poll_emit().is_none());
        w.set(5);
        let t = w.poll_emit().expect("text");
        assert!(t.ends_with('s'), "{t}");
        assert!(w.poll_emit().is_none());
        w.clear();
        assert_eq!(w.poll_emit().as_deref(), Some(""));
    }
}

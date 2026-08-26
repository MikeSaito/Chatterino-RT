//! IVR.fi Twitch subage API (Chatterino IvrApi; MIT reimplementation, no C++/Qt copy).

use std::time::Duration;

use chrono::{DateTime, Datelike, Timelike, Utc};
use serde::Serialize;
use serde_json::Value;

const API_BASE: &str = "https://api.ivr.fi/v2";
const ATTEMPTS: u32 = 3;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UserSubageResult {
    pub followage: Option<String>,
    pub followage_ago: Option<String>,
    pub subage: Option<String>,
}

fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .user_agent("Chatterino-RT/0.1")
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

fn format_follow_date(followed_at: &str) -> Option<String> {
    let dt = parse_followed_at(followed_at)?;
    Some(dt.format("%Y-%m-%d").to_string())
}

fn parse_followed_at(raw: &str) -> Option<DateTime<Utc>> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    DateTime::parse_from_rfc3339(trimmed)
        .map(|d| d.with_timezone(&Utc))
        .ok()
        .or_else(|| {
            // Date-only YYYY-MM-DD
            if trimmed.len() >= 10 {
                let date = &trimmed[..10];
                chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
                    .ok()
                    .and_then(|d| d.and_hms_opt(0, 0, 0))
                    .map(|n| DateTime::<Utc>::from_naive_utc_and_offset(n, Utc))
            } else {
                None
            }
        })
}

fn plural(n: u32, unit: &str) -> String {
    if n == 1 {
        format!("1 {unit}")
    } else {
        format!("{n} {unit}s")
    }
}

fn days_in_month(year: i32, month: u32) -> i32 {
    chrono::NaiveDate::from_ymd_opt(year, month, 1)
        .and_then(|d| d.checked_add_months(chrono::Months::new(1)))
        .and_then(|d| d.pred_opt())
        .map(|d| d.day() as i32)
        .unwrap_or(30)
}

/// Calendar-ish friendly duration (years/months/days/hours/minutes/seconds), up to 4 components.
pub(crate) fn format_long_friendly_duration(from: DateTime<Utc>, to: DateTime<Utc>) -> String {
    if to < from {
        return "0 seconds".into();
    }
    let mut years = to.year() - from.year();
    let mut months = to.month() as i32 - from.month() as i32;
    let mut days = to.day() as i32 - from.day() as i32;
    let mut hours = to.hour() as i32 - from.hour() as i32;
    let mut minutes = to.minute() as i32 - from.minute() as i32;
    let mut seconds = to.second() as i32 - from.second() as i32;

    if seconds < 0 {
        seconds += 60;
        minutes -= 1;
    }
    if minutes < 0 {
        minutes += 60;
        hours -= 1;
    }
    if hours < 0 {
        hours += 24;
        days -= 1;
    }
    if days < 0 {
        let (py, pm) = if to.month() == 1 {
            (to.year() - 1, 12u32)
        } else {
            (to.year(), to.month() - 1)
        };
        days += days_in_month(py, pm);
        months -= 1;
    }
    if months < 0 {
        months += 12;
        years -= 1;
    }
    if years < 0 {
        return "0 seconds".into();
    }

    let parts: Vec<String> = [
        (years as u32, "year"),
        (months as u32, "month"),
        (days as u32, "day"),
        (hours as u32, "hour"),
        (minutes as u32, "minute"),
        (seconds as u32, "second"),
    ]
    .into_iter()
    .filter(|(n, _)| *n > 0)
    .take(4)
    .map(|(n, u)| plural(n, u))
    .collect();

    if parts.is_empty() {
        return "0 seconds".into();
    }
    match parts.len() {
        1 => parts[0].clone(),
        2 => format!("{} and {}", parts[0], parts[1]),
        n => {
            let last = &parts[n - 1];
            let head = parts[..n - 1].join(", ");
            format!("{head}, and {last}")
        }
    }
}

pub(crate) fn parse_subage_json(root: &Value) -> UserSubageResult {
    let followed_at = root
        .get("followedAt")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let (followage, followage_ago) = if let Some(raw) = followed_at {
        if let Some(date) = format_follow_date(raw) {
            let ago = parse_followed_at(raw).map(|from| {
                format!(
                    "{} ago",
                    format_long_friendly_duration(from, Utc::now())
                )
            });
            (Some(format!("❤ Following since {date}")), ago)
        } else {
            (None, None)
        }
    } else {
        (None, None)
    };

    let status_hidden = root
        .get("statusHidden")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let months = root
        .get("cumulative")
        .and_then(|c| c.get("months"))
        .and_then(Value::as_i64)
        .unwrap_or(0)
        .max(0);
    let meta = root.get("meta");
    let is_subbed = meta.map(|m| !m.is_null()).unwrap_or(false);
    let tier = meta
        .and_then(Value::as_object)
        .and_then(|o| o.get("tier"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let subage = if status_hidden {
        Some("Subscription status hidden".into())
    } else if is_subbed {
        let tier_label = tier.unwrap_or("1");
        Some(format!(
            "★ Tier {tier_label} - Subscribed for {months} months"
        ))
    } else if months > 0 {
        Some(format!("★ Previously subscribed for {months} months"))
    } else {
        None
    };

    UserSubageResult {
        followage,
        followage_ago,
        subage,
    }
}

pub async fn fetch_subage(user_login: &str, channel_login: &str) -> Result<UserSubageResult, String> {
    let url = format!("{API_BASE}/twitch/subage/{user_login}/{channel_login}");
    let client = http_client();
    let mut delay = Duration::from_millis(200);
    let mut last_err = String::from("IVR request failed");

    for attempt in 0..ATTEMPTS {
        match client
            .get(&url)
            .header("Accept", "application/json")
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => {
                let body: Value = resp.json().await.map_err(|e| e.to_string())?;
                return Ok(parse_subage_json(&body));
            }
            Ok(resp) if resp.status().as_u16() == 404 => {
                return Ok(UserSubageResult {
                    followage: None,
                    followage_ago: None,
                    subage: None,
                });
            }
            Ok(resp) if resp.status().is_redirection() => {
                return Err(format!("IVR HTTP {} (redirects not followed)", resp.status()));
            }
            Ok(resp) if resp.status().as_u16() == 401 || resp.status().as_u16() == 403 => {
                return Err(format!("IVR HTTP {}", resp.status()));
            }
            Ok(resp) => {
                last_err = format!("IVR HTTP {}", resp.status());
            }
            Err(e) => {
                last_err = e.to_string();
            }
        }
        if attempt + 1 < ATTEMPTS {
            tokio::time::sleep(delay).await;
            delay = delay.saturating_mul(2);
        }
    }
    Err(last_err)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn parse_following_and_subbed() {
        let root = serde_json::json!({
            "followedAt": "2020-03-15T12:00:00.000Z",
            "statusHidden": false,
            "meta": { "tier": "3" },
            "cumulative": { "months": 42 }
        });
        let r = parse_subage_json(&root);
        assert_eq!(
            r.followage.as_deref(),
            Some("❤ Following since 2020-03-15")
        );
        assert!(r.followage_ago.as_ref().is_some_and(|s| s.ends_with(" ago")));
        assert_eq!(
            r.subage.as_deref(),
            Some("★ Tier 3 - Subscribed for 42 months")
        );
    }

    #[test]
    fn parse_status_hidden() {
        let root = serde_json::json!({
            "statusHidden": true,
            "meta": null,
            "cumulative": { "months": 5 }
        });
        let r = parse_subage_json(&root);
        assert!(r.followage.is_none());
        assert_eq!(r.subage.as_deref(), Some("Subscription status hidden"));
    }

    #[test]
    fn parse_previously_subscribed() {
        let root = serde_json::json!({
            "statusHidden": false,
            "meta": null,
            "cumulative": { "months": 7 }
        });
        let r = parse_subage_json(&root);
        assert_eq!(
            r.subage.as_deref(),
            Some("★ Previously subscribed for 7 months")
        );
    }

    #[test]
    fn parse_empty() {
        let root = serde_json::json!({
            "statusHidden": false,
            "meta": null,
            "cumulative": { "months": 0 }
        });
        let r = parse_subage_json(&root);
        assert!(r.followage.is_none());
        assert!(r.followage_ago.is_none());
        assert!(r.subage.is_none());
    }

    #[test]
    fn friendly_duration_minutes() {
        let from = Utc.with_ymd_and_hms(2024, 1, 1, 12, 0, 0).unwrap();
        let to = Utc.with_ymd_and_hms(2024, 1, 1, 12, 5, 30).unwrap();
        let s = format_long_friendly_duration(from, to);
        assert_eq!(s, "5 minutes and 30 seconds");
    }

    #[test]
    fn friendly_duration_years_months() {
        let from = Utc.with_ymd_and_hms(2017, 1, 10, 6, 0, 0).unwrap();
        let to = Utc.with_ymd_and_hms(2024, 2, 16, 12, 0, 0).unwrap();
        let s = format_long_friendly_duration(from, to);
        assert!(s.contains("year"));
        assert!(s.contains("month") || s.contains("day") || s.contains("hour"));
    }

    #[test]
    fn parse_iso_with_time() {
        let dt = parse_followed_at("2020-03-15T12:30:00.000Z").unwrap();
        assert_eq!(dt.hour(), 12);
        assert_eq!(dt.minute(), 30);
        assert_eq!(format_follow_date("2020-03-15T12:30:00.000Z").as_deref(), Some("2020-03-15"));
    }

    #[test]
    fn format_follow_date_rejects_bad() {
        assert!(format_follow_date("nope").is_none());
    }
}

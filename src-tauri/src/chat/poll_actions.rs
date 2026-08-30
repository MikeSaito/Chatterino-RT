//! Viewer poll vote and prediction bet via Twitch GQL.
//! Helix exposes only broadcaster manage/read endpoints; participation matches Channel Points.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Value};

const ATTEMPTS: u32 = 3;
const GQL_URL: &str = "https://gql.twitch.tv/gql";
const MAX_ID_CHARS: usize = 128;
const PREDICT_MIN_POINTS: u64 = 10;
const PREDICT_MAX_POINTS: u64 = 250_000;

static TRANSACTION_SEQ: AtomicU64 = AtomicU64::new(1);
static LAST_FAIL_LOG_MS: AtomicU64 = AtomicU64::new(0);

const VOTE_IN_POLL_MUTATION: &str = r#"
mutation VoteInPoll($input: VoteInPollInput!) {
  voteInPoll(input: $input) {
    error {
      code
    }
    voter {
      id
    }
  }
}
"#;

const MAKE_PREDICTION_MUTATION: &str = r#"
mutation MakePrediction($input: MakePredictionInput!) {
  makePrediction(input: $input) {
    error {
      code
    }
  }
}
"#;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PollVoteResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PredictionBetResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    pub points: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PollActionsError {
    pub code: String,
    pub message: String,
    pub params: BTreeMap<String, String>,
}

impl PollActionsError {
    pub fn coded(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            params: BTreeMap::new(),
        }
    }

    pub fn coded_params(
        code: impl Into<String>,
        message: impl Into<String>,
        params: BTreeMap<String, String>,
    ) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            params,
        }
    }
}

pub async fn vote_in_poll(
    shared: &super::state::Shared,
    poll_id: &str,
    choice_id: &str,
) -> Result<PollVoteResult, PollActionsError> {
    let poll_id = validate_id(poll_id, "error.polls.poll_id", "Invalid poll id")?;
    let choice_id = validate_id(choice_id, "error.polls.choice_id", "Invalid choice id")?;
    let (client_id, token) = graph_creds(shared).ok_or_else(|| {
        PollActionsError::coded("error.auth.required", "Twitch login required")
    })?;
    let user_id = super::auth::ensure_twitch_user_id(shared)
        .await
        .ok_or_else(|| {
            PollActionsError::coded(
                "error.polls.relogin",
                "Re-login with Twitch to vote in polls",
            )
        })?;
    let value = post_gql(
        &client_id,
        &token,
        json!({
            "operationName": "VoteInPoll",
            "variables": {
                "input": {
                    "pollID": poll_id,
                    "choiceID": choice_id,
                    "userID": user_id,
                    "voteID": transaction_id(),
                }
            },
            "query": VOTE_IN_POLL_MUTATION,
        }),
    )
    .await?;
    let payload = value
        .get("data")
        .and_then(|v| v.get("voteInPoll"))
        .unwrap_or(&Value::Null);
    if payload.is_null() {
        return Err(PollActionsError::coded(
            "error.polls.vote",
            "Poll vote failed",
        ));
    }
    let error_code = payload
        .get("error")
        .and_then(|v| v.get("code"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let voter_ok = payload
        .get("voter")
        .and_then(|v| v.get("id"))
        .and_then(Value::as_str)
        .is_some_and(|s| !s.is_empty());
    Ok(PollVoteResult {
        ok: error_code.is_none() && voter_ok,
        error_code,
    })
}

pub async fn make_prediction(
    shared: &super::state::Shared,
    event_id: &str,
    outcome_id: &str,
    points: u64,
) -> Result<PredictionBetResult, PollActionsError> {
    let event_id = validate_id(event_id, "error.polls.event_id", "Invalid prediction id")?;
    let outcome_id = validate_id(outcome_id, "error.polls.outcome_id", "Invalid outcome id")?;
    let points = validate_predict_points(points)?;
    let (client_id, token) = graph_creds(shared).ok_or_else(|| {
        PollActionsError::coded("error.auth.required", "Twitch login required")
    })?;
    // Ensure token still resolves to a user id (stale sessions fail early).
    if super::auth::ensure_twitch_user_id(shared).await.is_none() {
        return Err(PollActionsError::coded(
            "error.polls.relogin",
            "Re-login with Twitch to place predictions",
        ));
    }
    let value = post_gql(
        &client_id,
        &token,
        json!({
            "operationName": "MakePrediction",
            "variables": {
                "input": {
                    "eventID": event_id,
                    "outcomeID": outcome_id,
                    "points": points,
                    "transactionID": transaction_id(),
                }
            },
            "query": MAKE_PREDICTION_MUTATION,
        }),
    )
    .await?;
    let payload = value
        .get("data")
        .and_then(|v| v.get("makePrediction"))
        .unwrap_or(&Value::Null);
    if payload.is_null() {
        return Err(PollActionsError::coded(
            "error.polls.predict",
            "Prediction bet failed",
        ));
    }
    let error_code = payload
        .get("error")
        .and_then(|v| v.get("code"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    Ok(PredictionBetResult {
        ok: error_code.is_none(),
        error_code,
        points,
    })
}

fn graph_creds(shared: &super::state::Shared) -> Option<(String, String)> {
    let (client_id, token) = super::auth::oauth_graph_creds(shared)?;
    if client_id.trim().is_empty() || client_id == "YOUR_API_KEY_HERE" {
        return None;
    }
    let token = token.trim().trim_start_matches("oauth:").to_string();
    if token.is_empty() || token == "YOUR_API_KEY_HERE" {
        return None;
    }
    Some((client_id, token))
}

fn validate_id(raw: &str, code: &str, message: &str) -> Result<String, PollActionsError> {
    let id = raw.trim();
    if id.is_empty() || id.len() > MAX_ID_CHARS {
        return Err(PollActionsError::coded(code, message));
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
    {
        return Err(PollActionsError::coded(code, message));
    }
    Ok(id.to_string())
}

fn validate_predict_points(points: u64) -> Result<u64, PollActionsError> {
    if points < PREDICT_MIN_POINTS || points > PREDICT_MAX_POINTS {
        return Err(PollActionsError::coded_params(
            "error.polls.points_range",
            format!("Prediction stake must be {PREDICT_MIN_POINTS}–{PREDICT_MAX_POINTS}"),
            BTreeMap::from([
                ("min".into(), PREDICT_MIN_POINTS.to_string()),
                ("max".into(), PREDICT_MAX_POINTS.to_string()),
            ]),
        ));
    }
    Ok(points)
}

async fn post_gql(client_id: &str, token: &str, body: Value) -> Result<Value, PollActionsError> {
    let client = super::http_client::build(Duration::from_secs(12));
    let mut delay = Duration::from_millis(200);
    let mut last = String::from("no response");
    for attempt in 0..ATTEMPTS {
        match client
            .post(GQL_URL)
            .header("Client-Id", client_id)
            .header("Authorization", format!("OAuth {token}"))
            .header("Accept", "application/json")
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
        {
            Ok(resp) => {
                let status = resp.status();
                match resp.json::<Value>().await {
                    Ok(v) if status.is_success() => {
                        let data_ok = v
                            .get("data")
                            .is_some_and(|d| !d.is_null() && d != &Value::Null);
                        if data_ok {
                            return Ok(v);
                        }
                        if let Some(message) = gql_error_message(&v) {
                            last = message;
                        } else {
                            last = "empty GraphQL data".into();
                        }
                    }
                    Ok(v) => {
                        let message = gql_error_message(&v).unwrap_or_else(|| {
                            v.get("message")
                                .and_then(Value::as_str)
                                .unwrap_or("GraphQL error")
                                .to_string()
                        });
                        if status.as_u16() == 401 || status.as_u16() == 403 {
                            return Err(PollActionsError::coded(
                                "error.polls.relogin",
                                "Re-login with Twitch to use polls and predictions",
                            ));
                        }
                        last = format!("http {status}: {message}");
                    }
                    Err(e) => last = format!("json: {e}"),
                }
            }
            Err(e) => last = e.to_string(),
        }
        if attempt + 1 < ATTEMPTS {
            tokio::time::sleep(delay).await;
            delay *= 2;
        }
    }
    super::fetch::log_http_fail_throttled(
        &LAST_FAIL_LOG_MS,
        "poll-actions",
        &format!("after {ATTEMPTS} attempts: {last}"),
        GQL_URL,
    );
    Err(PollActionsError::coded(
        "error.polls.gql",
        "Could not reach Twitch for polls or predictions",
    ))
}

fn gql_error_message(value: &Value) -> Option<String> {
    let first = value
        .get("errors")
        .and_then(Value::as_array)
        .and_then(|arr| arr.first())?;
    first
        .get("message")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn transaction_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = TRANSACTION_SEQ.fetch_add(1, Ordering::Relaxed) as u128;
    let pid = std::process::id() as u128;
    let mut x = nanos ^ (seq << 32) ^ (pid << 96);
    x &= !(0xfu128 << 76);
    x |= 0x4u128 << 76;
    x &= !(0x3u128 << 62);
    x |= 0x2u128 << 62;
    let s = format!("{x:032x}");
    format!(
        "{}-{}-{}-{}-{}",
        &s[0..8],
        &s[8..12],
        &s[12..16],
        &s[16..20],
        &s[20..32]
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_id_accepts_uuid_shape() {
        assert!(validate_id(
            "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
            "error.polls.poll_id",
            "bad"
        )
        .is_ok());
    }

    #[test]
    fn validate_id_rejects_path_and_empty() {
        assert!(validate_id("../x", "error.polls.poll_id", "bad").is_err());
        assert!(validate_id("", "error.polls.poll_id", "bad").is_err());
        assert!(validate_id(&"a".repeat(MAX_ID_CHARS + 1), "error.polls.poll_id", "bad").is_err());
    }

    #[test]
    fn validate_predict_points_bounds() {
        assert!(validate_predict_points(9).is_err());
        assert_eq!(validate_predict_points(10).unwrap(), 10);
        assert_eq!(validate_predict_points(250_000).unwrap(), 250_000);
        assert!(validate_predict_points(250_001).is_err());
    }

    #[test]
    fn parse_vote_error_code_from_payload() {
        let v = json!({
            "data": {
                "voteInPoll": {
                    "error": { "code": "POLL_NOT_ACTIVE" },
                    "voter": null
                }
            }
        });
        let payload = v.pointer("/data/voteInPoll").unwrap();
        let code = payload
            .get("error")
            .and_then(|e| e.get("code"))
            .and_then(Value::as_str);
        assert_eq!(code, Some("POLL_NOT_ACTIVE"));
    }

    #[test]
    fn transaction_id_has_uuid_shape() {
        let id = transaction_id();
        assert_eq!(id.len(), 36);
        assert_eq!(id.as_bytes()[14], b'4');
        assert!(matches!(id.as_bytes()[19], b'8' | b'9' | b'a' | b'b'));
    }
}

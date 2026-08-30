use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Value};
use url::Url;

const ATTEMPTS: u32 = 3;
const GQL_URL: &str = "https://gql.twitch.tv/gql";
const MAX_REDEEM_TEXT_CHARS: usize = 500;
const MAX_REWARD_ID_CHARS: usize = 128;
const REWARD_IMAGE_HOSTS: &[&str] = &["static-cdn.jtvnw.net"];

static TRANSACTION_SEQ: AtomicU64 = AtomicU64::new(1);
static LAST_POINTS_FAIL_LOG_MS: AtomicU64 = AtomicU64::new(0);

const CHANNEL_POINTS_CONTEXT_QUERY: &str = r#"
query ChannelPointsContext($channelLogin: String!) {
  community(login: $channelLogin) {
    id
    displayName
    channel {
      id
      self {
        communityPoints {
          balance
          availableClaim {
            id
          }
        }
        subscriptionBenefit {
          id
        }
      }
      communityPointsSettings {
        isEnabled
        name
        image {
          url
          url2x
          url4x
        }
        defaultImage {
          url
          url2x
          url4x
        }
        customRewards {
          id
          title
          prompt
          cost
          backgroundColor
          cooldownExpiresAt
          isEnabled
          isPaused
          isInStock
          isSubOnly
          isUserInputRequired
          image {
            url
            url2x
            url4x
          }
          defaultImage {
            url
            url2x
            url4x
          }
          globalCooldownSetting {
            isEnabled
            globalCooldownSeconds
          }
          maxPerStreamSetting {
            isEnabled
            maxPerStream
          }
          maxPerUserPerStreamSetting {
            isEnabled
            maxPerUserPerStream
          }
          redemptionsRedeemedCurrentStream
        }
      }
    }
  }
}
"#;

const REDEEM_REWARD_MUTATION: &str = r#"
mutation RedeemCommunityPointsCustomReward($input: RedeemCommunityPointsCustomRewardInput!) {
  redeemCommunityPointsCustomReward(input: $input) {
    error {
      code
    }
    redemption {
      id
    }
  }
}
"#;

const CLAIM_POINTS_MUTATION: &str = r#"
mutation ClaimCommunityPoints($input: ClaimCommunityPointsInput!) {
  claimCommunityPoints(input: $input) {
    currentPoints
    error {
      code
    }
  }
}
"#;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChannelPointsSnapshot {
    pub channel: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub points_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub balance: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub available_claim_id: Option<String>,
    #[serde(default)]
    pub is_subscribed: bool,
    pub enabled: bool,
    pub auth_required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
    pub rewards: Vec<ChannelPointReward>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChannelPointReward {
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    pub cost: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub background_color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_url: Option<String>,
    pub is_enabled: bool,
    pub is_paused: bool,
    pub is_in_stock: bool,
    pub is_sub_only: bool,
    pub is_user_input_required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cooldown_expires_at: Option<String>,
    pub global_cooldown_seconds: Option<u64>,
    pub max_per_stream: Option<u64>,
    pub max_per_user_per_stream: Option<u64>,
    pub redemptions_redeemed_current_stream: Option<u64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChannelPointsRedeemResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub redemption_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    pub balance: Option<u64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChannelPointsClaimResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    pub balance: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChannelPointsError {
    pub code: String,
    pub message: String,
    pub params: BTreeMap<String, String>,
}

impl ChannelPointsError {
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

    pub fn internal(message: impl Into<String>) -> Self {
        Self::coded("internal", message)
    }
}

pub async fn snapshot(
    shared: &super::state::Shared,
    channel: &str,
) -> Result<ChannelPointsSnapshot, ChannelPointsError> {
    let channel = super::commands::normalize_channel(channel)
        .map_err(|e| ChannelPointsError::coded_params(e.code, e.message, e.params))?;
    let Some((client_id, token)) = graph_creds(shared) else {
        return Ok(ChannelPointsSnapshot {
            channel,
            channel_id: None,
            display_name: None,
            points_name: None,
            balance: None,
            available_claim_id: None,
            is_subscribed: false,
            enabled: false,
            auth_required: true,
            unavailable_reason: None,
            rewards: Vec::new(),
        });
    };
    let value = post_gql(
        &client_id,
        &token,
        json!({
            "operationName": "ChannelPointsContext",
            "variables": { "channelLogin": channel },
            "query": CHANNEL_POINTS_CONTEXT_QUERY,
        }),
    )
    .await?;
    Ok(parse_context(&value, &channel))
}

pub async fn redeem(
    shared: &super::state::Shared,
    channel: &str,
    reward_id: &str,
    text_input: Option<&str>,
) -> Result<ChannelPointsRedeemResult, ChannelPointsError> {
    let reward_id = validate_reward_id(reward_id)?;
    let text_input = validate_redeem_text(text_input)?;
    let current = snapshot(shared, channel).await?;
    if current.auth_required {
        return Err(ChannelPointsError::coded(
            "error.auth.required",
            "Twitch login required",
        ));
    }
    if !current.enabled {
        return Err(ChannelPointsError::coded(
            "error.points.unavailable",
            "Channel points are unavailable for this channel",
        ));
    }
    let Some(channel_id) = current.channel_id.as_deref() else {
        return Err(ChannelPointsError::coded(
            "error.points.channel_id",
            "Channel points channel id is unavailable",
        ));
    };
    let reward = current
        .rewards
        .iter()
        .find(|item| item.id == reward_id)
        .ok_or_else(|| {
            ChannelPointsError::coded("error.points.reward_missing", "Reward not found")
        })?;
    validate_reward_available(reward, current.balance, current.is_subscribed)?;
    let prompt = reward.prompt.as_deref().filter(|s| !s.is_empty());
    if reward.is_user_input_required && text_input.is_none() {
        return Err(ChannelPointsError::coded(
            "error.points.text_required",
            "Reward text is required",
        ));
    }
    let mut input = json!({
        "channelID": channel_id,
        "rewardID": reward.id,
        "title": reward.title,
        "cost": reward.cost,
        "prompt": prompt,
        "transactionID": transaction_id(),
    });
    if let Some(text) = text_input {
        input["textInput"] = Value::String(text.to_string());
    }
    let Some((client_id, token)) = graph_creds(shared) else {
        return Err(ChannelPointsError::coded(
            "error.auth.required",
            "Twitch login required",
        ));
    };
    let value = post_gql(
        &client_id,
        &token,
        json!({
            "operationName": "RedeemCommunityPointsCustomReward",
            "variables": { "input": input },
            "query": REDEEM_REWARD_MUTATION,
        }),
    )
    .await?;
    let payload = value
        .get("data")
        .and_then(|v| v.get("redeemCommunityPointsCustomReward"))
        .unwrap_or(&Value::Null);
    let error_code = payload
        .get("error")
        .and_then(|v| v.get("code"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let redemption_id = payload
        .get("redemption")
        .and_then(|v| v.get("id"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let fresh_balance = snapshot(shared, channel).await.ok().and_then(|s| s.balance);
    Ok(ChannelPointsRedeemResult {
        ok: error_code.is_none() && redemption_id.is_some(),
        redemption_id,
        error_code,
        balance: fresh_balance.or(current.balance.map(|b| b.saturating_sub(reward.cost))),
    })
}

pub async fn claim(
    shared: &super::state::Shared,
    channel: &str,
    claim_id: &str,
) -> Result<ChannelPointsClaimResult, ChannelPointsError> {
    let claim_id = validate_reward_id(claim_id)?;
    let current = snapshot(shared, channel).await?;
    if current.auth_required {
        return Err(ChannelPointsError::coded(
            "error.auth.required",
            "Twitch login required",
        ));
    }
    if current.available_claim_id.as_deref() != Some(claim_id.as_str()) {
        return Err(ChannelPointsError::coded(
            "error.points.claim_missing",
            "Channel points claim is unavailable",
        ));
    }
    let Some(channel_id) = current.channel_id.as_deref() else {
        return Err(ChannelPointsError::coded(
            "error.points.channel_id",
            "Channel points channel id is unavailable",
        ));
    };
    let Some((client_id, token)) = graph_creds(shared) else {
        return Err(ChannelPointsError::coded(
            "error.auth.required",
            "Twitch login required",
        ));
    };
    let value = post_gql(
        &client_id,
        &token,
        json!({
            "operationName": "ClaimCommunityPoints",
            "variables": {
                "input": {
                    "channelID": channel_id,
                    "claimID": claim_id,
                }
            },
            "query": CLAIM_POINTS_MUTATION,
        }),
    )
    .await?;
    let payload = value
        .get("data")
        .and_then(|v| v.get("claimCommunityPoints"))
        .filter(|v| !v.is_null());
    let Some(payload) = payload else {
        return Err(ChannelPointsError::coded(
            "error.points.claim_missing",
            "Channel points claim is unavailable",
        ));
    };
    let error_code = payload
        .get("error")
        .and_then(|v| v.get("code"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let balance = payload.get("currentPoints").and_then(as_u64);
    Ok(ChannelPointsClaimResult {
        ok: error_code.is_none() && balance.is_some(),
        error_code,
        balance: balance.or(current.balance),
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

fn validate_reward_id(raw: &str) -> Result<String, ChannelPointsError> {
    let id = raw.trim();
    if id.is_empty() || id.len() > MAX_REWARD_ID_CHARS {
        return Err(ChannelPointsError::coded(
            "error.points.reward_id",
            "Invalid reward id",
        ));
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(ChannelPointsError::coded(
            "error.points.reward_id",
            "Invalid reward id",
        ));
    }
    Ok(id.to_string())
}

fn validate_redeem_text(raw: Option<&str>) -> Result<Option<String>, ChannelPointsError> {
    let Some(text) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    if text.chars().count() > MAX_REDEEM_TEXT_CHARS {
        return Err(ChannelPointsError::coded_params(
            "error.points.text_too_long",
            format!("Reward text is longer than {MAX_REDEEM_TEXT_CHARS} characters"),
            BTreeMap::from([("max".into(), MAX_REDEEM_TEXT_CHARS.to_string())]),
        ));
    }
    if text
        .chars()
        .any(|c| matches!(c, '\0' | '\r' | '\n' | '\u{0001}'))
    {
        return Err(ChannelPointsError::coded(
            "error.points.text_chars",
            "Reward text contains forbidden characters",
        ));
    }
    Ok(Some(text.to_string()))
}

fn validate_reward_available(
    reward: &ChannelPointReward,
    balance: Option<u64>,
    is_subscribed: bool,
) -> Result<(), ChannelPointsError> {
    if !reward.is_enabled || reward.is_paused || !reward.is_in_stock {
        return Err(ChannelPointsError::coded(
            "error.points.reward_unavailable",
            "Reward is unavailable",
        ));
    }
    let Some(points) = balance else {
        return Err(ChannelPointsError::coded(
            "error.points.balance_unknown",
            "Channel points balance is unavailable",
        ));
    };
    if points < reward.cost {
        return Err(ChannelPointsError::coded(
            "error.points.not_enough",
            "Not enough channel points",
        ));
    }
    if reward.is_sub_only && !is_subscribed {
        return Err(ChannelPointsError::coded(
            "error.points.sub_only",
            "Reward is for subscribers only",
        ));
    }
    if let (Some(max), Some(used)) = (
        reward.max_per_stream,
        reward.redemptions_redeemed_current_stream,
    ) {
        if used >= max {
            return Err(ChannelPointsError::coded(
                "error.points.reward_unavailable",
                "Reward is unavailable",
            ));
        }
    }
    if cooldown_active(reward.cooldown_expires_at.as_deref()) {
        return Err(ChannelPointsError::coded(
            "error.points.reward_cooldown",
            "Reward is on cooldown",
        ));
    }
    Ok(())
}

fn cooldown_active(raw: Option<&str>) -> bool {
    let Some(raw) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return false;
    };
    let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(raw) else {
        return false;
    };
    parsed.timestamp_millis() > chrono::Utc::now().timestamp_millis()
}

fn parse_context(value: &Value, channel: &str) -> ChannelPointsSnapshot {
    let community = value
        .get("data")
        .and_then(|v| v.get("community"))
        .filter(|v| !v.is_null());
    let channel_node = community.and_then(|v| v.get("channel"));
    let settings = channel_node.and_then(|v| v.get("communityPointsSettings"));
    let self_node = channel_node.and_then(|v| v.get("self"));
    let self_points = self_node.and_then(|v| v.get("communityPoints"));
    let available_claim_id = self_points
        .and_then(|v| v.get("availableClaim"))
        .and_then(|v| v.get("id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .and_then(|id| validate_reward_id(id).ok());
    let is_subscribed = self_node
        .and_then(|v| v.get("subscriptionBenefit"))
        .filter(|v| !v.is_null())
        .and_then(|v| v.get("id"))
        .and_then(Value::as_str)
        .is_some_and(|s| !s.trim().is_empty());
    let channel_id = channel_node
        .and_then(|v| v.get("id"))
        .and_then(Value::as_str)
        .filter(|s| valid_twitch_id(s))
        .map(str::to_string)
        .or_else(|| {
            community
                .and_then(|v| v.get("id"))
                .and_then(Value::as_str)
                .filter(|s| valid_twitch_id(s))
                .map(str::to_string)
        });
    let enabled = settings
        .and_then(|v| v.get("isEnabled"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let rewards = settings
        .and_then(|v| v.get("customRewards"))
        .and_then(Value::as_array)
        .map(|arr| arr.iter().filter_map(parse_reward).collect())
        .unwrap_or_default();
    ChannelPointsSnapshot {
        channel: channel.to_string(),
        channel_id,
        display_name: community
            .and_then(|v| v.get("displayName"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        points_name: settings
            .and_then(|v| v.get("name"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        balance: self_points.and_then(|v| v.get("balance")).and_then(as_u64),
        available_claim_id,
        is_subscribed,
        enabled,
        auth_required: false,
        unavailable_reason: if community.is_none() {
            Some("not_found".into())
        } else if !enabled {
            Some("disabled".into())
        } else {
            None
        },
        rewards,
    }
}

fn parse_reward(item: &Value) -> Option<ChannelPointReward> {
    let id = item.get("id").and_then(Value::as_str)?.trim();
    if validate_reward_id(id).is_err() {
        return None;
    }
    let title = item
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.chars().count() <= 120)?
        .to_string();
    let cost = item.get("cost").and_then(as_u64)?;
    Some(ChannelPointReward {
        id: id.to_string(),
        title,
        prompt: item
            .get("prompt")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty() && s.chars().count() <= 500)
            .map(str::to_string),
        cost,
        background_color: item
            .get("backgroundColor")
            .and_then(Value::as_str)
            .and_then(normalize_hex_color),
        image_url: best_image_url(item.get("image"))
            .or_else(|| best_image_url(item.get("defaultImage"))),
        is_enabled: item
            .get("isEnabled")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        is_paused: item
            .get("isPaused")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        is_in_stock: item
            .get("isInStock")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        is_sub_only: item
            .get("isSubOnly")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        is_user_input_required: item
            .get("isUserInputRequired")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        cooldown_expires_at: item
            .get("cooldownExpiresAt")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        global_cooldown_seconds: setting_u64(
            item.get("globalCooldownSetting"),
            "globalCooldownSeconds",
        ),
        max_per_stream: setting_u64(item.get("maxPerStreamSetting"), "maxPerStream"),
        max_per_user_per_stream: setting_u64(
            item.get("maxPerUserPerStreamSetting"),
            "maxPerUserPerStream",
        ),
        redemptions_redeemed_current_stream: item
            .get("redemptionsRedeemedCurrentStream")
            .and_then(as_u64),
    })
}

fn setting_u64(setting: Option<&Value>, key: &str) -> Option<u64> {
    let setting = setting?;
    if setting
        .get("isEnabled")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        setting.get(key).and_then(as_u64)
    } else {
        None
    }
}

fn best_image_url(image: Option<&Value>) -> Option<String> {
    let image = image?;
    ["url4x", "url2x", "url"]
        .iter()
        .filter_map(|key| image.get(*key).and_then(Value::as_str))
        .find_map(allowed_reward_image_url)
}

fn allowed_reward_image_url(raw: &str) -> Option<String> {
    let parsed = Url::parse(raw.trim()).ok()?;
    if parsed.scheme() != "https" {
        return None;
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return None;
    }
    let host = parsed.host_str()?;
    if !REWARD_IMAGE_HOSTS.iter().any(|h| *h == host) {
        return None;
    }
    Some(parsed.as_str().to_string())
}

fn normalize_hex_color(raw: &str) -> Option<String> {
    let s = raw.trim();
    let hex = s.strip_prefix('#').unwrap_or(s);
    if hex.len() != 6 || !hex.as_bytes().iter().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    Some(format!("#{hex}"))
}

fn as_u64(v: &Value) -> Option<u64> {
    v.as_u64()
        .or_else(|| v.as_i64().and_then(|n| u64::try_from(n).ok()))
}

fn valid_twitch_id(raw: &str) -> bool {
    !raw.is_empty() && raw.chars().all(|c| c.is_ascii_digit())
}

async fn post_gql(client_id: &str, token: &str, body: Value) -> Result<Value, ChannelPointsError> {
    let client = http_client();
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
                            return Err(ChannelPointsError::coded(
                                "error.points.relogin",
                                "Re-login with Twitch to use channel points",
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
        &LAST_POINTS_FAIL_LOG_MS,
        "channel-points",
        &format!("after {ATTEMPTS} attempts: {last}"),
        GQL_URL,
    );
    Err(ChannelPointsError::coded_params(
        "error.points.gql",
        last.clone(),
        BTreeMap::from([("detail".into(), last)]),
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

fn http_client() -> reqwest::Client {
    super::http_client::build(Duration::from_secs(12))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_context_reads_balance_and_rewards() {
        let v = json!({
            "data": {
                "community": {
                    "id": "1",
                    "displayName": "Pajlada",
                    "channel": {
                        "id": "1",
                        "self": {
                            "communityPoints": { "balance": 12345, "availableClaim": { "id": "claim-1" } },
                            "subscriptionBenefit": { "id": "sub-1" }
                        },
                        "communityPointsSettings": {
                            "isEnabled": true,
                            "name": "Bananas",
                            "customRewards": [{
                                "id": "reward-1",
                                "title": "Highlight",
                                "prompt": "say hi",
                                "cost": 100,
                                "backgroundColor": "00FFAA",
                                "isEnabled": true,
                                "isPaused": false,
                                "isInStock": true,
                                "isSubOnly": false,
                                "isUserInputRequired": true,
                                "image": null,
                                "defaultImage": {
                                    "url": "https://static-cdn.jtvnw.net/custom-reward-images/default-1.png",
                                    "url2x": "https://static-cdn.jtvnw.net/custom-reward-images/default-2.png",
                                    "url4x": "https://static-cdn.jtvnw.net/custom-reward-images/default-4.png"
                                },
                                "globalCooldownSetting": { "isEnabled": true, "globalCooldownSeconds": 30 },
                                "maxPerStreamSetting": { "isEnabled": false, "maxPerStream": 1 },
                                "maxPerUserPerStreamSetting": { "isEnabled": true, "maxPerUserPerStream": 2 },
                                "redemptionsRedeemedCurrentStream": 1
                            }]
                        }
                    }
                }
            }
        });
        let out = parse_context(&v, "pajlada");
        assert!(out.enabled);
        assert_eq!(out.balance, Some(12345));
        assert_eq!(out.available_claim_id.as_deref(), Some("claim-1"));
        assert!(out.is_subscribed);
        assert_eq!(out.points_name.as_deref(), Some("Bananas"));
        assert_eq!(out.rewards.len(), 1);
        assert_eq!(out.rewards[0].background_color.as_deref(), Some("#00FFAA"));
        assert_eq!(out.rewards[0].global_cooldown_seconds, Some(30));
        assert_eq!(out.rewards[0].max_per_stream, None);
        assert_eq!(out.rewards[0].max_per_user_per_stream, Some(2));
        assert!(out.rewards[0]
            .image_url
            .as_deref()
            .unwrap()
            .ends_with("default-4.png"));
    }

    #[test]
    fn parse_reward_rejects_bad_url_and_id() {
        let bad_id = json!({
            "id": "../x",
            "title": "Bad",
            "cost": 1
        });
        assert!(parse_reward(&bad_id).is_none());

        let bad_url = json!({
            "id": "reward",
            "title": "Reward",
            "cost": 1,
            "isEnabled": true,
            "isPaused": false,
            "isInStock": true,
            "isSubOnly": false,
            "isUserInputRequired": false,
            "image": { "url": "javascript:alert(1)" }
        });
        let parsed = parse_reward(&bad_url).expect("reward");
        assert!(parsed.image_url.is_none());
    }

    #[test]
    fn validate_redeem_text_rejects_controls_and_long() {
        assert!(validate_redeem_text(Some("hello")).unwrap().is_some());
        assert!(validate_redeem_text(Some("line\nbreak")).is_err());
        assert!(validate_redeem_text(Some(&"a".repeat(MAX_REDEEM_TEXT_CHARS + 1))).is_err());
    }

    #[test]
    fn transaction_id_has_uuid_shape() {
        let id = transaction_id();
        assert_eq!(id.len(), 36);
        assert_eq!(id.as_bytes()[14], b'4');
        assert!(matches!(id.as_bytes()[19], b'8' | b'9' | b'a' | b'b'));
    }
}

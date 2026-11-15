use std::collections::{BTreeMap, HashSet};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};

use super::commands::{normalize_channel, ApiError};
use super::fetch::{allowed_twitch_gif_url, gif_url_matches_id};
use super::hub::Hub;
use super::state::Shared;
use super::types::{ChatEvent, EmoteSpan};

const GQL: &str = "https://gql.twitch.tv/gql";
const GIF_AVAILABILITY: &str = r#"
query ChatGifAvailability($channelID: ID!) {
    currentUser { id }
    gifPickerConfig(channelID: $channelID) { isEnabled isAllowlisted }
    user(id: $channelID) { self { subscriptionBenefit { tier } } }
    channelShieldMode(channelID: $channelID) { isActive }
}
"#;
const SEND_GIF: &str = r#"
mutation sendGifMessage($input: SendGifMessageInput!) {
    sendGifMessage(input: $input) {
        error
        secondsUntilCanSend
        message { id }
    }
}
"#;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentGif {
    message_id: String,
    gif_id: String,
    title: String,
    url: String,
}

fn gifs_in(event: &ChatEvent) -> impl Iterator<Item = &EmoteSpan> {
    let spans = match event {
        ChatEvent::Privmsg {
            emote_spans,
            disabled: false,
            ..
        } => emote_spans.as_slice(),
        _ => &[],
    };
    spans.iter().filter(|span| span.provider == "twitch-gif")
}

fn collect_recent<'a>(events: impl Iterator<Item = &'a ChatEvent>, query: &str) -> Vec<RecentGif> {
    let mut seen = HashSet::new();
    events
        .flat_map(|event| gifs_in(event).map(move |span| (event, span)))
        .filter_map(|(event, span)| {
            let ChatEvent::Privmsg { text, .. } = event else {
                return None;
            };
            if !query.is_empty() && !text.to_lowercase().contains(query) {
                return None;
            }
            let url = gif_url(span)?;
            if !seen.insert(span.emote_id.as_str()) {
                return None;
            }
            Some(RecentGif {
                message_id: event.id().to_string(),
                gif_id: span.emote_id.clone(),
                title: text.trim().chars().take(120).collect(),
                url,
            })
        })
        .take(24)
        .collect()
}

fn gif_url(span: &EmoteSpan) -> Option<String> {
    let url = allowed_twitch_gif_url(&span.url)?;
    gif_url_matches_id(&url, &span.emote_id).then_some(url)
}

#[tauri::command]
pub fn chat_recent_gifs(
    state: tauri::State<'_, Shared>,
    channel: String,
    query: String,
) -> Result<Vec<RecentGif>, ApiError> {
    let channel = normalize_channel(&channel)?;
    let query: String = query.trim().to_lowercase().chars().take(120).collect();
    let hub = state.hub.lock().map_err(|_| ApiError::internal("lock"))?;
    Ok(collect_recent(hub.channel_events(&channel).rev(), &query))
}

fn gif_room_id<'a>(hub: &'a Hub, channel: &str) -> Option<&'a str> {
    hub.room_id(channel).filter(|_| {
        hub.is_joined(channel)
            && !hub
                .room_modes(channel)
                .is_some_and(|modes| modes.emote_only)
    })
}

fn confirmed_access(body: &Value) -> bool {
    let data = &body["data"];
    let config = &data["gifPickerConfig"];
    let tier = &data["user"]["self"]["subscriptionBenefit"]["tier"];
    body.get("errors")
        .is_none_or(|errors| errors.as_array().is_some_and(Vec::is_empty))
        && data["currentUser"]["id"]
            .as_str()
            .is_some_and(|id| !id.is_empty())
        && config["isEnabled"].as_bool() == Some(true)
        && config["isAllowlisted"].as_bool() == Some(true)
        && data["channelShieldMode"]["isActive"].as_bool() == Some(false)
        && (matches!(tier.as_str(), Some("2000" | "3000"))
            || matches!(tier.as_u64(), Some(2000 | 3000)))
}

fn graph_request(
    client: &reqwest::Client,
    creds: &(String, String),
    body: Value,
) -> reqwest::RequestBuilder {
    client
        .post(GQL)
        .header("Client-Id", &creds.0)
        .header(
            "Authorization",
            format!("OAuth {}", creds.1.trim_start_matches("oauth:")),
        )
        .json(&body)
}

async fn gif_access(client: &reqwest::Client, creds: &(String, String), room_id: &str) -> bool {
    let body = json!({
        "operationName": "ChatGifAvailability",
        "variables": { "channelID": room_id },
        "query": GIF_AVAILABILITY,
    });
    let Ok(response) = graph_request(client, creds, body)
        .timeout(Duration::from_secs(6))
        .send()
        .await
    else {
        return false;
    };
    response.status().is_success()
        && response
            .json::<Value>()
            .await
            .is_ok_and(|body| confirmed_access(&body))
}

fn current_context(
    shared: &Shared,
    channel: &str,
    room_id: &str,
    creds: &(String, String),
) -> bool {
    super::auth::oauth_graph_creds(shared).as_ref() == Some(creds)
        && shared
            .hub
            .lock()
            .is_ok_and(|hub| gif_room_id(&hub, channel) == Some(room_id))
}

#[tauri::command]
pub async fn chat_gif_available(
    state: tauri::State<'_, Shared>,
    channel: String,
) -> Result<bool, ApiError> {
    let channel = normalize_channel(&channel)?;
    let Some(creds) = super::auth::oauth_graph_creds(&state) else {
        return Ok(false);
    };
    let room_id = state
        .hub
        .lock()
        .map(|hub| gif_room_id(&hub, &channel).map(str::to_owned))
        .map_err(|_| ApiError::internal("lock"))?;
    let Some(room_id) = room_id else {
        return Ok(false);
    };
    let client = super::http_client::build_no_redirect(Duration::from_secs(6));
    Ok(gif_access(&client, &creds, &room_id).await
        && current_context(&state, &channel, &room_id, &creds))
}

fn send_payload(channel_id: &str, gif_id: &str, url: &str) -> Value {
    json!({
        "operationName": "sendGifMessage",
        "variables": { "input": { "channelID": channel_id, "gifID": gif_id, "gifURL": url } },
        "query": SEND_GIF,
    })
}

fn unknown_delivery() -> ApiError {
    ApiError::coded("error.gif.unknown", "Twitch did not confirm GIF delivery")
}

fn unavailable() -> ApiError {
    ApiError::coded(
        "error.gif.unavailable",
        "Twitch did not allow GIF sending in this session",
    )
}

fn accepted_id(body: &Value) -> Result<String, ApiError> {
    let payload = &body["data"]["sendGifMessage"];
    if let Some(error) = payload["error"].as_str().filter(|s| !s.is_empty()) {
        if error == "TEMPORARILY_UNAVAILABLE" {
            return Err(unavailable());
        }
        if let Some(seconds) = payload["secondsUntilCanSend"].as_u64().filter(|n| *n > 0) {
            return Err(ApiError::coded_params(
                "error.gif.wait",
                format!("Twitch asks you to wait {seconds} seconds before sending a GIF"),
                BTreeMap::from([("seconds".into(), seconds.to_string())]),
            ));
        }
        let reason = if error.len() <= 80
            && error
                .bytes()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == b'_')
        {
            error
        } else {
            "UNKNOWN"
        };
        return Err(ApiError::coded_params(
            "error.gif.rejected",
            format!("Twitch rejected the GIF ({reason})"),
            BTreeMap::from([("reason".into(), reason.into())]),
        ));
    }
    if body["errors"]
        .as_array()
        .is_some_and(|errors| !errors.is_empty())
    {
        return Err(unavailable());
    }
    payload["message"]["id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .ok_or_else(unknown_delivery)
}

#[tauri::command]
pub async fn chat_send_gif(
    state: tauri::State<'_, Shared>,
    channel: String,
    message_id: String,
    gif_id: String,
) -> Result<String, ApiError> {
    let channel = normalize_channel(&channel)?;
    let creds = super::auth::oauth_graph_creds(&state)
        .ok_or_else(|| ApiError::coded("error.auth.required_send", "Twitch login required"))?;
    let (room_id, url) = {
        let hub = state.hub.lock().map_err(|_| ApiError::internal("lock"))?;
        if !hub.is_joined(&channel) || hub.room_id(&channel).is_none() {
            return Err(ApiError::coded(
                "error.gif.channel",
                "Join the channel before sending a GIF",
            ));
        }
        let room_id = gif_room_id(&hub, &channel).ok_or_else(unavailable)?;
        let url = hub
            .channel_events(&channel)
            .rev()
            .find(|event| event.id() == message_id)
            .and_then(|event| gifs_in(event).find(|span| span.emote_id == gif_id))
            .and_then(gif_url)
            .ok_or_else(|| {
                ApiError::coded(
                    "error.gif.missing",
                    "This GIF is no longer in the channel history",
                )
            })?;
        (room_id.to_string(), url)
    };
    let client = super::http_client::build_no_redirect(Duration::from_secs(12));
    if !gif_access(&client, &creds, &room_id).await
        || !current_context(&state, &channel, &room_id, &creds)
    {
        return Err(unavailable());
    }
    // A lost response can follow an accepted send, so do not retry the mutation.
    let response = graph_request(&client, &creds, send_payload(&room_id, &gif_id, &url))
        .send()
        .await
        .map_err(|_| unknown_delivery())?;
    if response.status().is_client_error() {
        return Err(unavailable());
    }
    if !response.status().is_success() {
        return Err(unknown_delivery());
    }
    let body = response
        .json::<Value>()
        .await
        .map_err(|_| unknown_delivery())?;
    accepted_id(&body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::parse::{parse_line, ParsedLine};

    #[test]
    fn access_requires_an_authenticated_tier_and_enabled_channel() {
        let allowed = json!({"data": {
            "currentUser": {"id": "42"},
            "gifPickerConfig": {"isEnabled": true, "isAllowlisted": true},
            "channelShieldMode": {"isActive": false},
            "user": {"self": {"subscriptionBenefit": {"tier": "2000"}}}
        }});
        assert!(confirmed_access(&allowed));
        let mut tier_three = allowed.clone();
        tier_three["data"]["user"]["self"]["subscriptionBenefit"]["tier"] = json!("3000");
        assert!(confirmed_access(&tier_three));
        for (path, value) in [
            ("/data/currentUser", Value::Null),
            ("/data/user/self/subscriptionBenefit/tier", json!("1000")),
            ("/data/user/self/subscriptionBenefit", Value::Null),
            ("/data/gifPickerConfig/isEnabled", json!(false)),
            ("/data/gifPickerConfig/isAllowlisted", json!(false)),
            ("/data/channelShieldMode/isActive", json!(true)),
            ("/data/channelShieldMode", Value::Null),
        ] {
            let mut denied = allowed.clone();
            *denied.pointer_mut(path).unwrap() = value;
            assert!(!confirmed_access(&denied), "{path}");
        }
        let mut failed = allowed;
        failed["errors"] = json!([{"message": "no access"}]);
        assert!(!confirmed_access(&failed));
        assert!(!confirmed_access(&Value::Null));
    }

    #[test]
    fn selects_received_gifs_and_preserves_the_original_url() {
        let url = "https://media2.giphy.com/media/FixtureGif/giphy.gif?cid=sample";
        let line = format!(
            "@id=fixture;gifs=0-11|FixtureGif|{url} :viewer!v@v PRIVMSG #fixture :[GIF by You]"
        );
        let ParsedLine::Event { event, .. } = parse_line(&line, 42) else {
            panic!("expected a chat event");
        };
        let choices = collect_recent([&event, &event].into_iter(), "gif");
        assert_eq!(choices.len(), 1);
        let choice = &choices[0];
        assert_eq!(choice.message_id, "fixture");
        assert_eq!(choice.gif_id, "FixtureGif");
        let input = &send_payload("42", &choice.gif_id, &choice.url)["variables"]["input"];
        assert_eq!(
            input,
            &json!({"channelID":"42", "gifID":"FixtureGif", "gifURL":url})
        );
        assert!(collect_recent([&event].into_iter(), "missing").is_empty());
    }

    #[test]
    fn only_reports_success_for_confirmed_message_ids() {
        let accepted = json!({"data":{"sendGifMessage":{"error":null,"message":{"id":"fixture"}}}});
        assert_eq!(accepted_id(&accepted).unwrap(), "fixture");
        let rejected =
            json!({"data":{"sendGifMessage":{"error":"COOLDOWN","secondsUntilCanSend":7}}});
        let err = accepted_id(&rejected).unwrap_err();
        assert_eq!(err.code, "error.gif.wait");
        assert_eq!(err.params["seconds"], "7");
        assert_eq!(
            accepted_id(&json!({"errors":[{"message":"requires challenge"}]}))
                .unwrap_err()
                .code,
            "error.gif.unavailable"
        );
        assert_eq!(
            accepted_id(&json!({"data":{"sendGifMessage":{"error":null}}}))
                .unwrap_err()
                .code,
            "error.gif.unknown"
        );
    }
}

use std::collections::{BTreeMap, HashSet};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};

use super::commands::{normalize_channel, ApiError};
use super::fetch::{allowed_twitch_gif_url, gif_url_matches_id};
use super::state::Shared;
use super::types::{ChatEvent, EmoteSpan};

const GQL: &str = "https://gql.twitch.tv/gql";
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

fn accepted_id(body: &Value) -> Result<String, ApiError> {
    let payload = &body["data"]["sendGifMessage"];
    if let Some(error) = payload["error"].as_str().filter(|s| !s.is_empty()) {
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
        return Err(ApiError::coded(
            "error.gif.unavailable",
            "Twitch did not allow GIF sending in this session",
        ));
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
    let (client_id, token) = super::auth::oauth_graph_creds(&state)
        .ok_or_else(|| ApiError::coded("error.auth.required_send", "Twitch login required"))?;
    let (room_id, url) = {
        let hub = state.hub.lock().map_err(|_| ApiError::internal("lock"))?;
        let room_id = hub
            .room_id(&channel)
            .filter(|_| hub.is_joined(&channel))
            .ok_or_else(|| {
                ApiError::coded("error.gif.channel", "Join the channel before sending a GIF")
            })?;
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
    // A lost response can follow an accepted send, so do not retry the mutation.
    let response = client
        .post(GQL)
        .header("Client-Id", client_id)
        .header(
            "Authorization",
            format!("OAuth {}", token.trim_start_matches("oauth:")),
        )
        .json(&send_payload(&room_id, &gif_id, &url))
        .send()
        .await
        .map_err(|_| unknown_delivery())?;
    if response.status().is_client_error() {
        return Err(ApiError::coded(
            "error.gif.unavailable",
            "Twitch did not allow GIF sending in this session",
        ));
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

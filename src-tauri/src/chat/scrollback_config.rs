// MIT reimpl: Chatterino scrollbackSplitLimit / scrollbackUsercardLimit knobs.

use std::collections::BTreeMap;

use serde_json::Value;

pub const DEFAULT_SCROLLBACK_LIMIT: usize = 1000;
const MIN: usize = 100;
/// Upper bound for UI pool / split limit (GPU slots); keep well below 100k.
const MAX: usize = 10_000;

fn clamp_limit(raw: usize) -> usize {
    raw.clamp(MIN, MAX)
}

fn knob_usize(knobs: &BTreeMap<String, Value>, key: &str) -> Option<usize> {
    knobs.get(key).and_then(Value::as_u64).map(|n| n as usize)
}

pub fn scrollback_split_limit(knobs: &BTreeMap<String, Value>) -> usize {
    clamp_limit(knob_usize(knobs, "misc.scrollbackSplitLimit").unwrap_or(DEFAULT_SCROLLBACK_LIMIT))
}

pub fn scrollback_usercard_limit(knobs: &BTreeMap<String, Value>) -> usize {
    clamp_limit(
        knob_usize(knobs, "misc.scrollbackUsercardLimit").unwrap_or(DEFAULT_SCROLLBACK_LIMIT),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn knobs(pairs: &[(&str, Value)]) -> BTreeMap<String, Value> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect()
    }

    #[test]
    fn defaults_to_1000() {
        assert_eq!(scrollback_split_limit(&BTreeMap::new()), 1000);
        assert_eq!(scrollback_usercard_limit(&BTreeMap::new()), 1000);
    }

    #[test]
    fn clamps_split_and_usercard() {
        let low = knobs(&[("misc.scrollbackSplitLimit", json!(50))]);
        assert_eq!(scrollback_split_limit(&low), 100);
        let high = knobs(&[("misc.scrollbackUsercardLimit", json!(999_999))]);
        assert_eq!(scrollback_usercard_limit(&high), 10_000);
    }
}

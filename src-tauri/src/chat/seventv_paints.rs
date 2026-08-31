//! 7TV username paints via EventAPI (beyond stock Chatterino; Chatterino7-compatible wire).

use std::collections::HashMap;

use serde_json::Value;

use super::fetch::safe_object_id;
use super::types::{NickPaint, NickPaintShadow, NickPaintStop};

#[derive(Debug, Clone)]
struct PaintDef {
    paint: NickPaint,
}

#[derive(Debug, Default)]
pub struct SeventvPaintCatalog {
    known: HashMap<String, PaintDef>,
    /// Twitch user id → paint id.
    user_paints: HashMap<String, String>,
    /// Entitlements that arrived before cosmetic.create.
    pending_users: HashMap<String, Vec<String>>,
}

impl SeventvPaintCatalog {
    pub fn register_paint(&mut self, data: &Value) -> Option<String> {
        let id = data
            .get("id")
            .and_then(Value::as_str)
            .filter(|s| safe_object_id(s))?;
        if self.known.contains_key(id) {
            self.flush_pending(id);
            return Some(id.to_string());
        }
        let paint = parse_paint_def(data)?;
        self.known.insert(id.to_string(), PaintDef { paint });
        self.flush_pending(id);
        Some(id.to_string())
    }

    fn flush_pending(&mut self, paint_id: &str) {
        if let Some(users) = self.pending_users.remove(paint_id) {
            for user_id in users {
                self.user_paints.insert(user_id, paint_id.to_string());
            }
        }
    }

    pub fn assign_user(&mut self, ref_id: &str, user_id: &str) {
        if ref_id.is_empty() || user_id.is_empty() || !safe_object_id(ref_id) {
            return;
        }
        if !self.known.contains_key(ref_id) {
            let list = self.pending_users.entry(ref_id.to_string()).or_default();
            if !list.iter().any(|u| u == user_id) {
                list.push(user_id.to_string());
            }
            return;
        }
        self.user_paints
            .insert(user_id.to_string(), ref_id.to_string());
    }

    pub fn clear_user(&mut self, ref_id: &str, user_id: &str) {
        if ref_id.is_empty() || user_id.is_empty() {
            return;
        }
        if let Some(list) = self.pending_users.get_mut(ref_id) {
            list.retain(|u| u != user_id);
            if list.is_empty() {
                self.pending_users.remove(ref_id);
            }
        }
        if self.user_paints.get(user_id).is_some_and(|id| id == ref_id) {
            self.user_paints.remove(user_id);
        }
    }

    pub fn paint_for_user(&self, user_id: &str) -> Option<NickPaint> {
        let ref_id = self.user_paints.get(user_id)?;
        self.known.get(ref_id).map(|d| d.paint.clone())
    }
}

pub fn apply_cosmetic_create(catalog: &mut SeventvPaintCatalog, data: &Value) -> bool {
    let Some(obj) = data.get("body").and_then(|b| b.get("object")) else {
        return false;
    };
    if obj.get("kind").and_then(Value::as_str) != Some("PAINT") {
        return false;
    }
    let Some(paint_data) = obj.get("data") else {
        return false;
    };
    catalog.register_paint(paint_data).is_some()
}

pub fn parse_entitlement(data: &Value) -> Option<(String, String)> {
    let obj = data.get("body")?.get("object")?;
    if obj.get("kind").and_then(Value::as_str)? != "PAINT" {
        return None;
    }
    let ref_id = obj
        .get("ref_id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())?;
    let connections = obj.get("user")?.get("connections")?.as_array()?;
    for conn in connections {
        if conn.get("platform").and_then(Value::as_str) != Some("TWITCH") {
            continue;
        }
        let user_id = conn
            .get("id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())?;
        return Some((ref_id.to_string(), user_id.to_string()));
    }
    None
}

pub fn apply_entitlement_create(catalog: &mut SeventvPaintCatalog, data: &Value) -> bool {
    let Some((ref_id, user_id)) = parse_entitlement(data) else {
        return false;
    };
    catalog.assign_user(&ref_id, &user_id);
    true
}

pub fn apply_entitlement_delete(catalog: &mut SeventvPaintCatalog, data: &Value) -> bool {
    let Some((ref_id, user_id)) = parse_entitlement(data) else {
        return false;
    };
    catalog.clear_user(&ref_id, &user_id);
    true
}

fn parse_paint_def(data: &Value) -> Option<NickPaint> {
    let id = data
        .get("id")
        .and_then(Value::as_str)
        .filter(|s| safe_object_id(s))?
        .to_string();
    let name = data
        .get("name")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let (function, stops_val, angle, repeat) = normalize_gradient_fields(data)?;
    if function != "LINEAR_GRADIENT" && function != "linear-gradient" {
        // v1: solid fallback only when we have color / stops from non-linear.
        let color = parse_argb(data.get("color"));
        let stops = parse_stops(stops_val).unwrap_or_default();
        if color.is_none() && stops.is_empty() {
            return None;
        }
        return Some(NickPaint {
            id,
            name,
            angle: 90,
            repeat: false,
            stops,
            color,
            shadow: parse_first_shadow(data),
        });
    }

    let stops = parse_stops(stops_val).unwrap_or_default();
    let color = parse_argb(data.get("color"));
    if stops.is_empty() && color.is_none() {
        return None;
    }
    Some(NickPaint {
        id,
        name,
        angle,
        repeat,
        stops,
        color,
        shadow: parse_first_shadow(data),
    })
}

/// Prefer `gradients[0]` (current wire); else legacy flat fields.
fn normalize_gradient_fields(data: &Value) -> Option<(String, Option<&Value>, i32, bool)> {
    if let Some(g0) = data
        .get("gradients")
        .and_then(Value::as_array)
        .and_then(|a| a.first())
    {
        let function = g0
            .get("function")
            .and_then(Value::as_str)
            .unwrap_or("LINEAR_GRADIENT")
            .to_string();
        let angle = g0
            .get("angle")
            .and_then(Value::as_f64)
            .map(|v| v.round() as i32)
            .unwrap_or(90);
        let repeat = g0.get("repeat").and_then(Value::as_bool).unwrap_or(false);
        return Some((function, g0.get("stops"), angle, repeat));
    }
    let function = data
        .get("function")
        .and_then(Value::as_str)
        .unwrap_or("LINEAR_GRADIENT")
        .to_string();
    let angle = data
        .get("angle")
        .and_then(Value::as_f64)
        .map(|v| v.round() as i32)
        .unwrap_or(90);
    let repeat = data.get("repeat").and_then(Value::as_bool).unwrap_or(false);
    Some((function, data.get("stops"), angle, repeat))
}

fn parse_argb(v: Option<&Value>) -> Option<u32> {
    let v = v?;
    if v.is_null() {
        return None;
    }
    if let Some(n) = v.as_u64() {
        return Some(n as u32);
    }
    if let Some(n) = v.as_i64() {
        return Some(n as u32);
    }
    None
}

fn parse_stops(stops: Option<&Value>) -> Option<Vec<NickPaintStop>> {
    let arr = stops?.as_array()?;
    const MAX_STOPS: usize = 16;
    let mut out = Vec::new();
    let mut last_at: i32 = -1;
    for stop in arr.iter().take(MAX_STOPS) {
        let color = parse_argb(stop.get("color"))?;
        let mut at_f = stop.get("at").and_then(Value::as_f64).unwrap_or(0.0);
        at_f = at_f.clamp(0.0, 1.0);
        let mut at = (at_f * 10_000.0).round() as i32;
        // Hard-edge hack (Chatterino7): bump duplicate positions slightly.
        if at <= last_at {
            at = last_at + 1;
        }
        last_at = at;
        out.push(NickPaintStop {
            at: at.clamp(0, 10_000) as u16,
            color,
        });
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

fn parse_first_shadow(data: &Value) -> Option<NickPaintShadow> {
    let arr = data.get("shadows").and_then(Value::as_array)?;
    let first = arr.first()?;
    let color = parse_argb(first.get("color"))?;
    let x = first.get("x_offset").and_then(Value::as_f64).unwrap_or(0.0);
    let y = first.get("y_offset").and_then(Value::as_f64).unwrap_or(0.0);
    let radius = first.get("radius").and_then(Value::as_f64).unwrap_or(0.0);
    Some(NickPaintShadow {
        x_tenths: (x * 10.0).round() as i32,
        y_tenths: (y * 10.0).round() as i32,
        radius_tenths: (radius * 10.0).round() as i32,
        color,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_legacy_paint() -> Value {
        serde_json::json!({
            "id": "64aaaaaaaaaaaaaaaaaaaaaa",
            "name": "Example",
            "function": "LINEAR_GRADIENT",
            "color": 2139062271u64,
            "angle": 90,
            "repeat": false,
            "stops": [
                { "at": 0.0, "color": 4294902015u64 },
                { "at": 1.0, "color": 4278255615u64 }
            ],
            "shadows": [
                { "x_offset": 0, "y_offset": 1, "radius": 2, "color": 4278190080u64 }
            ]
        })
    }

    #[test]
    fn register_legacy_linear_paint() {
        let mut cat = SeventvPaintCatalog::default();
        let id = cat.register_paint(&sample_legacy_paint()).unwrap();
        assert_eq!(id, "64aaaaaaaaaaaaaaaaaaaaaa");
        cat.assign_user(&id, "777");
        let paint = cat.paint_for_user("777").unwrap();
        assert_eq!(paint.stops.len(), 2);
        assert_eq!(paint.angle, 90);
        assert!(paint.shadow.is_some());
    }

    #[test]
    fn register_gradients_array() {
        let mut cat = SeventvPaintCatalog::default();
        let data = serde_json::json!({
            "id": "64bbbbbbbbbbbbbbbbbbbbbb",
            "name": "Grad",
            "gradients": [{
                "function": "LINEAR_GRADIENT",
                "angle": 45,
                "repeat": false,
                "stops": [
                    { "at": 0.0, "color": 4294902015u64 },
                    { "at": 1.0, "color": 4278190335u64 }
                ]
            }],
            "shadows": []
        });
        cat.register_paint(&data).unwrap();
        let p = cat.known.get("64bbbbbbbbbbbbbbbbbbbbbb").unwrap();
        assert_eq!(p.paint.angle, 45);
        assert_eq!(p.paint.stops.len(), 2);
    }

    #[test]
    fn entitlement_twitch_id() {
        let mut cat = SeventvPaintCatalog::default();
        cat.register_paint(&sample_legacy_paint()).unwrap();
        let entitlement = serde_json::json!({
            "body": {
                "object": {
                    "kind": "PAINT",
                    "ref_id": "64aaaaaaaaaaaaaaaaaaaaaa",
                    "user": {
                        "connections": [{
                            "platform": "TWITCH",
                            "id": "999",
                            "username": "viewer"
                        }]
                    }
                }
            }
        });
        assert!(apply_entitlement_create(&mut cat, &entitlement));
        assert!(cat.paint_for_user("999").is_some());
        assert!(apply_entitlement_delete(&mut cat, &entitlement));
        assert!(cat.paint_for_user("999").is_none());
    }

    #[test]
    fn ignores_badge_cosmetic() {
        let mut cat = SeventvPaintCatalog::default();
        let data = serde_json::json!({
            "body": {
                "object": {
                    "kind": "BADGE",
                    "data": { "id": "badge1", "name": "x" }
                }
            }
        });
        assert!(!apply_cosmetic_create(&mut cat, &data));
    }

    #[test]
    fn cosmetic_create_registers() {
        let mut cat = SeventvPaintCatalog::default();
        let data = serde_json::json!({
            "body": {
                "object": {
                    "kind": "PAINT",
                    "data": sample_legacy_paint()
                }
            }
        });
        assert!(apply_cosmetic_create(&mut cat, &data));
    }

    #[test]
    fn entitlement_before_cosmetic_is_pending() {
        let mut cat = SeventvPaintCatalog::default();
        let entitlement = serde_json::json!({
            "body": {
                "object": {
                    "kind": "PAINT",
                    "ref_id": "64aaaaaaaaaaaaaaaaaaaaaa",
                    "user": {
                        "connections": [{
                            "platform": "TWITCH",
                            "id": "888",
                            "username": "early"
                        }]
                    }
                }
            }
        });
        assert!(apply_entitlement_create(&mut cat, &entitlement));
        assert!(cat.paint_for_user("888").is_none());
        assert!(apply_cosmetic_create(
            &mut cat,
            &serde_json::json!({
                "body": { "object": { "kind": "PAINT", "data": sample_legacy_paint() } }
            })
        ));
        assert!(cat.paint_for_user("888").is_some());
    }
}

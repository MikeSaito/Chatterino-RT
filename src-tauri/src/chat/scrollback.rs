use std::collections::VecDeque;

use super::constants::SCROLLBACK_LIMIT;
use super::types::ChatEvent;

#[derive(Debug, Default)]
pub struct Scrollback {
    items: VecDeque<ChatEvent>,
    limit: usize,
}

impl Scrollback {
    pub fn new() -> Self {
        Self {
            items: VecDeque::with_capacity(SCROLLBACK_LIMIT),
            limit: SCROLLBACK_LIMIT,
        }
    }

    pub fn push(&mut self, event: ChatEvent) {
        if self.items.len() == self.limit {
            self.items.pop_front();
        }
        self.items.push_back(event);
    }

    pub fn snapshot(&self) -> Vec<ChatEvent> {
        self.items.iter().cloned().collect()
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.items.len()
    }

    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::types::ChatEvent;

    fn notice(id: &str) -> ChatEvent {
        ChatEvent::Notice {
            id: id.to_string(),
            timestamp_ms: 1,
            text: id.to_string(),
        }
    }

    #[test]
    fn evicts_oldest_without_growing_past_limit() {
        let mut q = Scrollback::new();
        for i in 0..(SCROLLBACK_LIMIT + 5) {
            q.push(notice(&i.to_string()));
        }
        assert!(!q.is_empty());
        assert_eq!(q.len(), SCROLLBACK_LIMIT);
        let snap = q.snapshot();
        assert_eq!(snap.first().unwrap().id(), "5");
        assert_eq!(snap.last().unwrap().id(), &(SCROLLBACK_LIMIT + 4).to_string());
    }
}

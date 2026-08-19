use std::collections::HashMap;

use super::channel::ChannelBuf;
use super::types::{ChatBatch, ChatEvent};

#[derive(Default)]
pub struct Hub {
    pub active: Option<String>,
    buffers: HashMap<String, ChannelBuf>,
}

impl Hub {
    pub fn buffer(&mut self, channel: &str) -> &mut ChannelBuf {
        self.buffers
            .entry(channel.to_string())
            .or_insert_with(|| ChannelBuf::new(channel))
    }

    pub fn ingest(&mut self, channel: &str, event: ChatEvent) -> Option<ChatBatch> {
        self.buffer(channel).ingest(event)
    }

    pub fn flush_all(&mut self) -> Vec<ChatBatch> {
        self.buffers.values_mut().filter_map(|b| b.flush()).collect()
    }

    pub fn snapshot(&mut self, channel: &str) -> Option<ChatBatch> {
        let buf = self.buffers.get_mut(channel)?;
        let _ = buf.flush();
        Some(buf.snapshot_batch(channel))
    }

    pub fn set_active(&mut self, channel: Option<String>) {
        self.active = channel.clone();
        match &self.active {
            Some(ch) => self.buffers.retain(|k, _| k == ch),
            None => self.buffers.clear(),
        }
    }
}

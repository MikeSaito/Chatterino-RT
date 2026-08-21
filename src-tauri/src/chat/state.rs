use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use tauri::ipc::Channel;
use tokio::sync::mpsc;

use super::auth::AuthInner;
use super::batch::encode_batch;
use super::cheers::CheerCatalog;
use super::chatters::Chatters;
use super::emotes::Catalog;
use super::filters::{FiltersInner, HighlightSoundCtx};
use super::helix::BadgeCatalog;
use super::hub::Hub;
use super::session::SessionInner;
use super::settings::SettingsInner;
use super::types::ChatBatch;

#[derive(Debug, Clone)]
pub enum IrcCmd {
    Join(String),
    Part,
    PartChannel(String),
    Privmsg {
        channel: String,
        text: String,
        reply_to: Option<String>,
    },
    Relogin,
    Shutdown,
}

#[derive(Debug, Clone)]
pub enum EventCmd {
    SetGlobal { set_id: String },
    SetChannel {
        login: String,
        set_id: String,
        user_id: String,
    },
    ClearChannel,
    ClearGlobal,
    SetEnabled(bool),
    Shutdown,
}

#[derive(Debug, Clone)]
pub enum BttvCmd {
    SetChannel { login: String, room_id: String },
    ClearChannel,
    SetEnabled(bool),
    Shutdown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventWanted {
    pub enabled: bool,
    pub global_set: Option<String>,
    pub channel: Option<EventChannelWanted>,
}

impl Default for EventWanted {
    fn default() -> Self {
        Self {
            enabled: true,
            global_set: None,
            channel: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventChannelWanted {
    pub login: String,
    pub set_id: String,
    pub user_id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BttvWanted {
    pub enabled: bool,
    pub channel: Option<BttvChannelWanted>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BttvChannelWanted {
    pub login: String,
    pub room_id: String,
}

#[derive(Clone)]
pub struct Shared {
    pub hub: Arc<Mutex<Hub>>,
    pub catalog: Arc<Mutex<Catalog>>,
    pub badges: Arc<Mutex<BadgeCatalog>>,
    pub cheers: Arc<Mutex<CheerCatalog>>,
    pub irc_tx: Arc<Mutex<Option<mpsc::Sender<IrcCmd>>>>,
    pub event_tx: Arc<Mutex<Option<mpsc::UnboundedSender<EventCmd>>>>,
    pub event_wanted: Arc<Mutex<EventWanted>>,
    pub event_shutdown: Arc<AtomicBool>,
    pub bttv_tx: Arc<Mutex<Option<mpsc::UnboundedSender<BttvCmd>>>>,
    pub bttv_wanted: Arc<Mutex<BttvWanted>>,
    pub bttv_shutdown: Arc<AtomicBool>,
    pub auth: Arc<Mutex<AuthInner>>,
    pub filters: Arc<Mutex<FiltersInner>>,
    pub chatters: Arc<Mutex<Chatters>>,
    pub batch_tx: Arc<Mutex<Option<Channel<Vec<u8>>>>>,
    pub session: Arc<Mutex<SessionInner>>,
    pub settings: Arc<Mutex<SettingsInner>>,
    /// Compiled highlight phrase rules; refreshed on settings load/replace.
    pub highlight_sound: Arc<Mutex<HighlightSoundCtx>>,
    pub pending_highlight_sound: Arc<Mutex<Option<String>>>,
    /// Last successfully sent outbound PRIVMSG text per channel login.
    pub last_sent: Arc<Mutex<std::collections::HashMap<String, String>>>,
    /// Reserved outbound PRIVMSG slots (chat_send → wire flush).
    pub outbound_pending: Arc<AtomicUsize>,
}

pub enum BatchSend {
    Delivered,
    NoSubscriber,
    EncodeError,
}

impl Shared {
    pub fn new() -> Self {
        Self {
            hub: Arc::new(Mutex::new(Hub::default())),
            catalog: Arc::new(Mutex::new(Catalog::default())),
            badges: Arc::new(Mutex::new(BadgeCatalog::default())),
            cheers: Arc::new(Mutex::new(CheerCatalog::default())),
            irc_tx: Arc::new(Mutex::new(None)),
            event_tx: Arc::new(Mutex::new(None)),
            event_wanted: Arc::new(Mutex::new(EventWanted::default())),
            event_shutdown: Arc::new(AtomicBool::new(false)),
            bttv_tx: Arc::new(Mutex::new(None)),
            bttv_wanted: Arc::new(Mutex::new(BttvWanted {
                enabled: true,
                channel: None,
            })),
            bttv_shutdown: Arc::new(AtomicBool::new(false)),
            auth: Arc::new(Mutex::new(AuthInner::default())),
            filters: Arc::new(Mutex::new(FiltersInner::default())),
            chatters: Arc::new(Mutex::new(Chatters::default())),
            batch_tx: Arc::new(Mutex::new(None)),
            session: Arc::new(Mutex::new(SessionInner::default())),
            settings: Arc::new(Mutex::new(SettingsInner::default())),
            highlight_sound: Arc::new(Mutex::new(HighlightSoundCtx::default())),
            pending_highlight_sound: Arc::new(Mutex::new(None)),
            last_sent: Arc::new(Mutex::new(std::collections::HashMap::new())),
            outbound_pending: Arc::new(AtomicUsize::new(0)),
        }
    }

    pub fn try_reserve_outbound(&self, max: usize) -> bool {
        loop {
            let cur = self.outbound_pending.load(Ordering::Acquire);
            if cur >= max {
                return false;
            }
            if self
                .outbound_pending
                .compare_exchange(cur, cur + 1, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
            {
                return true;
            }
        }
    }

    pub fn release_outbound(&self, n: usize) {
        if n == 0 {
            return;
        }
        let _ = self
            .outbound_pending
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |cur| {
                Some(cur.saturating_sub(n))
            });
    }

    pub fn set_batch_channel(&self, channel: Channel<Vec<u8>>) -> Result<(), ()> {
        let mut slot = self.batch_tx.lock().map_err(|_| ())?;
        *slot = Some(channel);
        Ok(())
    }

    pub fn send_batch(&self, batch: &ChatBatch) -> BatchSend {
        let Ok(bytes) = encode_batch(batch) else {
            return BatchSend::EncodeError;
        };
        let Ok(slot) = self.batch_tx.lock() else {
            return BatchSend::NoSubscriber;
        };
        let Some(channel) = slot.as_ref() else {
            return BatchSend::NoSubscriber;
        };
        if channel.send(bytes).is_ok() {
            BatchSend::Delivered
        } else {
            BatchSend::NoSubscriber
        }
    }

    pub fn note_undelivered(&self, channel: &str, count: u32) {
        if let Ok(mut hub) = self.hub.lock() {
            if !hub.has_channel(channel) {
                return;
            }
            hub.buffer(channel).pending.note_undelivered(count);
        }
    }

    pub fn snapshot_event_wanted(&self) -> EventWanted {
        self.event_wanted
            .lock()
            .ok()
            .map(|w| w.clone())
            .unwrap_or_else(EventWanted::default)
    }

    pub fn apply_event_cmd(&self, cmd: &EventCmd) {
        match cmd {
            EventCmd::SetGlobal { set_id } => {
                if let Ok(mut wanted) = self.event_wanted.lock() {
                    wanted.global_set = Some(set_id.clone());
                }
            }
            EventCmd::SetChannel {
                login,
                set_id,
                user_id,
            } => {
                let Ok(hub) = self.hub.lock() else {
                    return;
                };
                if hub.active.as_deref() != Some(login.as_str()) {
                    return;
                }
                let Ok(mut wanted) = self.event_wanted.lock() else {
                    return;
                };
                wanted.channel = Some(EventChannelWanted {
                    login: login.clone(),
                    set_id: set_id.clone(),
                    user_id: user_id.clone(),
                });
            }
            EventCmd::ClearChannel => {
                if let Ok(mut wanted) = self.event_wanted.lock() {
                    wanted.channel = None;
                }
            }
            EventCmd::ClearGlobal => {
                if let Ok(mut wanted) = self.event_wanted.lock() {
                    wanted.global_set = None;
                }
            }
            EventCmd::SetEnabled(enabled) => {
                if let Ok(mut wanted) = self.event_wanted.lock() {
                    wanted.enabled = *enabled;
                }
            }
            EventCmd::Shutdown => {
                self.event_shutdown.store(true, Ordering::SeqCst);
            }
        }
    }

    pub fn notify_event(&self, cmd: EventCmd) {
        self.apply_event_cmd(&cmd);
        if let Ok(guard) = self.event_tx.lock() {
            if let Some(tx) = guard.as_ref() {
                let _ = tx.send(cmd);
            }
        }
    }

    pub fn snapshot_bttv_wanted(&self) -> BttvWanted {
        self.bttv_wanted
            .lock()
            .ok()
            .map(|w| w.clone())
            .unwrap_or(BttvWanted {
                enabled: true,
                channel: None,
            })
    }

    pub fn apply_bttv_cmd(&self, cmd: &BttvCmd) {
        match cmd {
            BttvCmd::SetChannel { login, room_id } => {
                let Ok(hub) = self.hub.lock() else {
                    return;
                };
                if hub.active.as_deref() != Some(login.as_str()) {
                    return;
                }
                let Ok(mut wanted) = self.bttv_wanted.lock() else {
                    return;
                };
                wanted.channel = Some(BttvChannelWanted {
                    login: login.clone(),
                    room_id: room_id.clone(),
                });
            }
            BttvCmd::ClearChannel => {
                if let Ok(mut wanted) = self.bttv_wanted.lock() {
                    wanted.channel = None;
                }
            }
            BttvCmd::SetEnabled(enabled) => {
                if let Ok(mut wanted) = self.bttv_wanted.lock() {
                    wanted.enabled = *enabled;
                }
            }
            BttvCmd::Shutdown => {
                self.bttv_shutdown.store(true, Ordering::SeqCst);
            }
        }
    }

    pub fn notify_bttv(&self, cmd: BttvCmd) {
        self.apply_bttv_cmd(&cmd);
        if let Ok(guard) = self.bttv_tx.lock() {
            if let Some(tx) = guard.as_ref() {
                let _ = tx.send(cmd);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_channel_requires_active_hub() {
        let shared = Shared::new();
        shared.notify_event(EventCmd::SetChannel {
            login: "xqc".into(),
            set_id: "set1".into(),
            user_id: "user1".into(),
        });
        assert!(shared.snapshot_event_wanted().channel.is_none());

        shared.hub.lock().unwrap().set_active(Some("xqc".into()));
        shared.notify_event(EventCmd::SetChannel {
            login: "xqc".into(),
            set_id: "set1".into(),
            user_id: "user1".into(),
        });
        let wanted = shared.snapshot_event_wanted();
        assert_eq!(wanted.channel.as_ref().map(|c| c.login.as_str()), Some("xqc"));

        shared.hub.lock().unwrap().set_active(Some("other".into()));
        shared.notify_event(EventCmd::ClearChannel);
        shared.notify_event(EventCmd::SetChannel {
            login: "xqc".into(),
            set_id: "set1".into(),
            user_id: "user1".into(),
        });
        assert!(shared.snapshot_event_wanted().channel.is_none());
    }
}

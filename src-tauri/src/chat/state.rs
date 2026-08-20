use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tauri::ipc::Channel;
use tokio::sync::mpsc;

use super::auth::AuthInner;
use super::batch::encode_batch;
use super::cheers::CheerCatalog;
use super::chatters::Chatters;
use super::emotes::Catalog;
use super::filters::FiltersInner;
use super::helix::BadgeCatalog;
use super::hub::Hub;
use super::types::ChatBatch;

#[derive(Debug, Clone)]
pub enum IrcCmd {
    Join(String),
    Part,
    Privmsg { channel: String, text: String },
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
    Shutdown,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EventWanted {
    pub global_set: Option<String>,
    pub channel: Option<EventChannelWanted>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventChannelWanted {
    pub login: String,
    pub set_id: String,
    pub user_id: String,
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
    pub auth: Arc<Mutex<AuthInner>>,
    pub filters: Arc<Mutex<FiltersInner>>,
    pub chatters: Arc<Mutex<Chatters>>,
    pub batch_tx: Arc<Mutex<Option<Channel<Vec<u8>>>>>,
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
            auth: Arc::new(Mutex::new(AuthInner::default())),
            filters: Arc::new(Mutex::new(FiltersInner::default())),
            chatters: Arc::new(Mutex::new(Chatters::default())),
            batch_tx: Arc::new(Mutex::new(None)),
        }
    }

    pub fn set_batch_channel(&self, channel: Channel<Vec<u8>>) -> Result<(), ()> {
        let mut slot = self.batch_tx.lock().map_err(|_| ())?;
        *slot = Some(channel);
        Ok(())
    }

    pub fn send_batch(&self, batch: &ChatBatch) {
        let Ok(bytes) = encode_batch(batch) else {
            return;
        };
        let Ok(slot) = self.batch_tx.lock() else {
            return;
        };
        let Some(channel) = slot.as_ref() else {
            return;
        };
        let _ = channel.send(bytes);
    }

    pub fn snapshot_event_wanted(&self) -> EventWanted {
        self.event_wanted
            .lock()
            .ok()
            .map(|w| w.clone())
            .unwrap_or_default()
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

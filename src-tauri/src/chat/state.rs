use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use tauri::ipc::Channel;
use tokio::sync::mpsc;

use super::auth::AuthInner;
use super::batch::encode_batch;
use super::cheers::CheerCatalog;
use super::chatters::Chatters;
use super::emotes::Catalog;
use super::filter_set::ExpressionFilterSet;
use super::filters::{BlacklistRule, FiltersInner, HighlightSoundCtx, PhraseRule, ReplaceRule};
use super::helix::BadgeCatalog;
use super::bttv_badges::BttvBadgeCatalog;
use super::chatterino_badges::ChatterinoBadgeCatalog;
use super::ffz_badges::FfzBadgeCatalog;
use super::ffz_channel::FfzChannelExtras;
use super::twitch_blocks::TwitchBlockSet;
use super::seventv_badges::SeventvBadgeCatalog;
use super::shared_chat::SharedChatState;
use super::hub::Hub;
use super::membership_batch::MembershipBatcher;
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
        room_id: String,
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
    BroadcastMe {
        room_id: String,
        twitch_user_id: String,
    },
    Shutdown,
}

#[derive(Default)]
pub struct ActivityInner {
    pub bttv_next: std::collections::HashMap<String, std::time::Instant>,
    pub seventv_next: std::collections::HashMap<String, std::time::Instant>,
    pub seventv_user_id: Option<String>,
    pub seventv_user_for: Option<String>,
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
    pub room_id: String,
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
    pub ffz_badges: Arc<Mutex<FfzBadgeCatalog>>,
    pub ffz_channel: Arc<Mutex<HashMap<String, FfzChannelExtras>>>,
    pub chatterino_badges: Arc<Mutex<ChatterinoBadgeCatalog>>,
    pub bttv_badges: Arc<Mutex<BttvBadgeCatalog>>,
    pub seventv_badges: Arc<Mutex<SeventvBadgeCatalog>>,
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
    /// Compiled Ignores Messages block rules; refreshed on settings load/replace.
    pub ignore_block_rules: Arc<Mutex<Vec<PhraseRule>>>,
    /// Compiled Ignores Messages replacement rules; refreshed on settings load/replace.
    pub ignore_replace_rules: Arc<Mutex<Vec<ReplaceRule>>>,
    /// Compiled Ignores Users drop rules; refreshed on settings load/replace.
    pub ignore_user_rules: Arc<Mutex<Vec<BlacklistRule>>>,
    /// Compiled Highlights Blacklisted Users rules; refreshed on settings load/replace.
    pub highlight_blacklist: Arc<Mutex<Vec<BlacklistRule>>>,
    pub pending_highlight_sound: Arc<Mutex<Option<String>>>,
    /// Whitelist of highlight sound paths from settings tables + default knob.
    pub allowed_highlight_sounds: Arc<Mutex<HashSet<String>>>,
    /// Last successfully sent outbound PRIVMSG text per channel login.
    pub last_sent: Arc<Mutex<std::collections::HashMap<String, String>>>,
    /// Reserved outbound PRIVMSG slots (chat_send → wire flush).
    pub outbound_pending: Arc<AtomicUsize>,
    pub membership_batch: Arc<Mutex<MembershipBatcher>>,
    /// In-flight recent-messages fetch per channel login.
    pub loading_recent: Arc<Mutex<HashSet<String>>>,
    pub activity: Arc<Mutex<ActivityInner>>,
    pub auth_user_id_fetch: Arc<tokio::sync::Mutex<()>>,
    pub send_rate: Arc<Mutex<super::send_wait::SendRateState>>,
    pub twitch_blocks: Arc<Mutex<TwitchBlockSet>>,
    pub shared_chat: Arc<Mutex<SharedChatState>>,
    pub expression_filters: Arc<Mutex<Arc<ExpressionFilterSet>>>,
    pub exclude_own_from_filter: Arc<Mutex<bool>>,
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
            ffz_badges: Arc::new(Mutex::new(FfzBadgeCatalog::default())),
            ffz_channel: Arc::new(Mutex::new(HashMap::new())),
            chatterino_badges: Arc::new(Mutex::new(ChatterinoBadgeCatalog::default())),
            bttv_badges: Arc::new(Mutex::new(BttvBadgeCatalog::default())),
            seventv_badges: Arc::new(Mutex::new(SeventvBadgeCatalog::default())),
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
            ignore_block_rules: Arc::new(Mutex::new(Vec::new())),
            ignore_replace_rules: Arc::new(Mutex::new(Vec::new())),
            ignore_user_rules: Arc::new(Mutex::new(Vec::new())),
            highlight_blacklist: Arc::new(Mutex::new(Vec::new())),
            pending_highlight_sound: Arc::new(Mutex::new(None)),
            allowed_highlight_sounds: Arc::new(Mutex::new(HashSet::new())),
            last_sent: Arc::new(Mutex::new(std::collections::HashMap::new())),
            outbound_pending: Arc::new(AtomicUsize::new(0)),
            membership_batch: Arc::new(Mutex::new(MembershipBatcher::default())),
            loading_recent: Arc::new(Mutex::new(HashSet::new())),
            activity: Arc::new(Mutex::new(ActivityInner::default())),
            auth_user_id_fetch: Arc::new(tokio::sync::Mutex::new(())),
            send_rate: Arc::new(Mutex::new(super::send_wait::SendRateState::default())),
            twitch_blocks: Arc::new(Mutex::new(TwitchBlockSet::default())),
            shared_chat: Arc::new(Mutex::new(SharedChatState::default())),
            expression_filters: Arc::new(Mutex::new(Arc::new(ExpressionFilterSet::default()))),
            exclude_own_from_filter: Arc::new(Mutex::new(false)),
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
                room_id,
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
                    room_id: room_id.clone(),
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
            BttvCmd::BroadcastMe { .. } => {}
            BttvCmd::Shutdown => {
                self.bttv_shutdown.store(true, Ordering::SeqCst);
            }
        }
    }

    pub fn notify_bttv(&self, cmd: BttvCmd) {
        if !matches!(cmd, BttvCmd::BroadcastMe { .. }) {
            self.apply_bttv_cmd(&cmd);
        }
        if let Ok(guard) = self.bttv_tx.lock() {
            if let Some(tx) = guard.as_ref() {
                let _ = tx.send(cmd);
            }
        }
    }
}

impl Shared {
    pub fn post_channel_notice(&self, app: &tauri::AppHandle, channel: &str, text: String) {
        use std::sync::atomic::{AtomicU64, Ordering};
        use tauri::Emitter;

        use super::auth;
        use super::types::{ChatEvent, ChatPipe, ChatSendWait};

        static SEQ: AtomicU64 = AtomicU64::new(1);
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let event = ChatEvent::Notice {
            id: format!("mb-{ts}-{seq}-{}", text.len()),
            timestamp_ms: ts,
            text,
        };
        let self_login = auth::resolved_login_token(self).map(|(l, _)| l);
        let sim = super::similarity::cfg_from_shared(self);
        let stack_style = super::timeout_stack::style_from_shared(self);
        let batch = self.hub.lock().ok().and_then(|mut hub| {
            hub.ingest(
                channel,
                event,
                self_login.as_deref(),
                &sim,
                stack_style,
            )
        });
        if let Some(batch) = batch {
            match self.send_batch(&batch) {
                BatchSend::Delivered => {}
                BatchSend::EncodeError | BatchSend::NoSubscriber => {
                    let n = u32::try_from(batch.events.len()).unwrap_or(u32::MAX).max(1);
                    self.note_undelivered(&batch.channel_id, n);
                    let _ = app.emit(
                        "chat:pipe",
                        ChatPipe {
                            ok: false,
                            channel: Some(batch.channel_id.clone()),
                        },
                    );
                }
            }
        }
        let updates = self
            .hub
            .lock()
            .ok()
            .map(|mut hub| hub.poll_send_waits())
            .unwrap_or_default();
        for (channel_id, wait_text) in updates {
            let _ = app.emit(
                "chat:send-wait",
                ChatSendWait {
                    channel_id,
                    text: wait_text,
                },
            );
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
            room_id: "999".into(),
            set_id: "set1".into(),
            user_id: "user1".into(),
        });
        assert!(shared.snapshot_event_wanted().channel.is_none());

        shared.hub.lock().unwrap().set_active(Some("xqc".into()));
        shared.notify_event(EventCmd::SetChannel {
            login: "xqc".into(),
            room_id: "999".into(),
            set_id: "set1".into(),
            user_id: "user1".into(),
        });
        let wanted = shared.snapshot_event_wanted();
        assert_eq!(wanted.channel.as_ref().map(|c| c.login.as_str()), Some("xqc"));
        assert_eq!(wanted.channel.as_ref().map(|c| c.room_id.as_str()), Some("999"));

        shared.hub.lock().unwrap().set_active(Some("other".into()));
        shared.notify_event(EventCmd::ClearChannel);
        shared.notify_event(EventCmd::SetChannel {
            login: "xqc".into(),
            room_id: "999".into(),
            set_id: "set1".into(),
            user_id: "user1".into(),
        });
        assert!(shared.snapshot_event_wanted().channel.is_none());
    }
}

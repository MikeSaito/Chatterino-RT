use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use tauri::ipc::Channel;
use tokio::sync::mpsc;

use super::auth::AuthInner;
use super::batch::encode_batch;
use super::bttv_badges::BttvBadgeCatalog;
use super::chatterino_badges::ChatterinoBadgeCatalog;
use super::chatters::Chatters;
use super::cheers::CheerCatalog;
use super::custom_commands::CustomCommandSet;
use super::emotes::Catalog;
use super::ffz_badges::FfzBadgeCatalog;
use super::ffz_channel::FfzChannelExtras;
use super::filter_set::ExpressionFilterSet;
use super::filters::{BlacklistRule, FiltersInner, HighlightSoundCtx, PhraseRule, ReplaceRule};
use super::helix::BadgeCatalog;
use super::hub::Hub;
use super::live_notifications::LiveNotifyState;
use super::logging::Logging;
use super::membership_batch::MembershipBatcher;
use super::low_trust::LowTrustCmd;
use super::pins::PinsCmd;
use super::polls::PollsCmd;
use super::session::SessionInner;
use super::settings::SettingsInner;
use super::seventv_badges::SeventvBadgeCatalog;
use super::seventv_paints::SeventvPaintCatalog;
use super::shared_bans::SharedBansCmd;
use super::shared_chat::SharedChatState;
use super::twitch_blocks::TwitchBlockSet;
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
    Typing {
        channel: String,
        active: bool,
    },
    Relogin,
    Shutdown,
}

#[derive(Debug, Clone)]
pub enum EventCmd {
    SetGlobal {
        set_id: String,
    },
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
    SetChannel {
        login: String,
        room_id: String,
    },
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

/// Кэш USERSTATE self-профиля по каналу для локального echo своего PRIVMSG:
/// Twitch не возвращает отправителю его сообщение на том же соединении.
#[derive(Debug, Clone, Default)]
pub struct SelfProfile {
    pub display_name: String,
    pub color: String,
    pub badges: Vec<super::types::Badge>,
}

#[derive(Clone)]
pub struct Shared {
    pub hub: Arc<Mutex<Hub>>,
    /// Последний USERSTATE (display-name/color/badges) по каналу.
    pub self_profiles: Arc<Mutex<HashMap<String, SelfProfile>>>,
    pub catalog: Arc<Mutex<Catalog>>,
    pub badges: Arc<Mutex<BadgeCatalog>>,
    pub ffz_badges: Arc<Mutex<FfzBadgeCatalog>>,
    pub ffz_channel: Arc<Mutex<HashMap<String, FfzChannelExtras>>>,
    pub chatterino_badges: Arc<Mutex<ChatterinoBadgeCatalog>>,
    pub bttv_badges: Arc<Mutex<BttvBadgeCatalog>>,
    pub seventv_badges: Arc<Mutex<SeventvBadgeCatalog>>,
    pub seventv_paints: Arc<Mutex<SeventvPaintCatalog>>,
    pub cheers: Arc<Mutex<CheerCatalog>>,
    pub irc_tx: Arc<Mutex<Option<mpsc::Sender<IrcCmd>>>>,
    pub event_tx: Arc<Mutex<Option<mpsc::UnboundedSender<EventCmd>>>>,
    pub event_wanted: Arc<Mutex<EventWanted>>,
    pub event_shutdown: Arc<AtomicBool>,
    pub bttv_tx: Arc<Mutex<Option<mpsc::UnboundedSender<BttvCmd>>>>,
    pub bttv_wanted: Arc<Mutex<BttvWanted>>,
    pub bttv_shutdown: Arc<AtomicBool>,
    pub polls_tx: Arc<Mutex<Option<mpsc::UnboundedSender<PollsCmd>>>>,
    pub polls_shutdown: Arc<AtomicBool>,
    pub low_trust_tx: Arc<Mutex<Option<mpsc::UnboundedSender<LowTrustCmd>>>>,
    pub low_trust_shutdown: Arc<AtomicBool>,
    pub pins_tx: Arc<Mutex<Option<mpsc::UnboundedSender<PinsCmd>>>>,
    pub pins_shutdown: Arc<AtomicBool>,
    pub shared_bans_tx: Arc<Mutex<Option<mpsc::UnboundedSender<SharedBansCmd>>>>,
    pub shared_bans_shutdown: Arc<AtomicBool>,
    pub auth: Arc<Mutex<AuthInner>>,
    pub filters: Arc<Mutex<FiltersInner>>,
    pub chatters: Arc<Mutex<Chatters>>,
    pub batch_tx: Arc<Mutex<Option<(u64, Channel<Vec<u8>>)>>>,
    /// Monotonic id for batch Channel install; stale unsubscribe must not clear a newer pipe.
    pub batch_gen: Arc<AtomicU64>,
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
    pub custom_commands: Arc<Mutex<Arc<CustomCommandSet>>>,
    pub logging: Arc<Mutex<Logging>>,
    pub live_notify: Arc<Mutex<LiveNotifyState>>,
    pub user_data: Arc<Mutex<super::user_data::UserDataStore>>,
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
            self_profiles: Arc::new(Mutex::new(HashMap::new())),
            catalog: Arc::new(Mutex::new(Catalog::default())),
            badges: Arc::new(Mutex::new(BadgeCatalog::default())),
            ffz_badges: Arc::new(Mutex::new(FfzBadgeCatalog::default())),
            ffz_channel: Arc::new(Mutex::new(HashMap::new())),
            chatterino_badges: Arc::new(Mutex::new(ChatterinoBadgeCatalog::default())),
            bttv_badges: Arc::new(Mutex::new(BttvBadgeCatalog::default())),
            seventv_badges: Arc::new(Mutex::new(SeventvBadgeCatalog::default())),
            seventv_paints: Arc::new(Mutex::new(SeventvPaintCatalog::default())),
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
            polls_tx: Arc::new(Mutex::new(None)),
            polls_shutdown: Arc::new(AtomicBool::new(false)),
            low_trust_tx: Arc::new(Mutex::new(None)),
            low_trust_shutdown: Arc::new(AtomicBool::new(false)),
            pins_tx: Arc::new(Mutex::new(None)),
            pins_shutdown: Arc::new(AtomicBool::new(false)),
            shared_bans_tx: Arc::new(Mutex::new(None)),
            shared_bans_shutdown: Arc::new(AtomicBool::new(false)),
            auth: Arc::new(Mutex::new(AuthInner::default())),
            filters: Arc::new(Mutex::new(FiltersInner::default())),
            chatters: Arc::new(Mutex::new(Chatters::default())),
            batch_tx: Arc::new(Mutex::new(None)),
            batch_gen: Arc::new(AtomicU64::new(0)),
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
            custom_commands: Arc::new(Mutex::new(Arc::new(CustomCommandSet::default()))),
            logging: Arc::new(Mutex::new(Logging::default())),
            live_notify: Arc::new(Mutex::new(LiveNotifyState::default())),
            user_data: Arc::new(Mutex::new(super::user_data::UserDataStore::default())),
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

    /// Install a JS Channel; returns generation so unsubscribe can ignore stale clears.
    pub fn set_batch_channel(&self, channel: Channel<Vec<u8>>) -> Result<u64, ()> {
        let gen = self.batch_gen.fetch_add(1, Ordering::AcqRel) + 1;
        let mut slot = self.batch_tx.lock().map_err(|_| ())?;
        *slot = Some((gen, channel));
        Ok(gen)
    }

    /// Drop the JS Channel so Rust stops delivering into stale HMR / remount callbacks.
    /// When `generation` is set, clear only if it still matches the installed pipe.
    pub fn clear_batch_channel(&self, generation: Option<u64>) -> Result<(), ()> {
        let mut slot = self.batch_tx.lock().map_err(|_| ())?;
        if let Some(want) = generation {
            match slot.as_ref() {
                Some((gen, _)) if *gen == want => {
                    *slot = None;
                }
                Some(_) | None => {}
            }
        } else {
            *slot = None;
        }
        Ok(())
    }

    pub fn send_batch(&self, batch: &ChatBatch) -> BatchSend {
        let Ok(bytes) = encode_batch(batch) else {
            return BatchSend::EncodeError;
        };
        let Ok(slot) = self.batch_tx.lock() else {
            return BatchSend::NoSubscriber;
        };
        let Some((_, channel)) = slot.as_ref() else {
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

    pub fn notify_polls(&self, cmd: PollsCmd) {
        if matches!(cmd, PollsCmd::Shutdown) {
            self.polls_shutdown.store(true, Ordering::SeqCst);
        }
        if let Ok(guard) = self.polls_tx.lock() {
            if let Some(tx) = guard.as_ref() {
                let _ = tx.send(cmd);
            }
        }
    }

    pub fn notify_low_trust(&self, cmd: LowTrustCmd) {
        if matches!(cmd, LowTrustCmd::Shutdown) {
            self.low_trust_shutdown.store(true, Ordering::SeqCst);
        }
        if let Ok(guard) = self.low_trust_tx.lock() {
            if let Some(tx) = guard.as_ref() {
                let _ = tx.send(cmd);
            }
        }
    }

    pub fn notify_pins(&self, cmd: PinsCmd) {
        if matches!(cmd, PinsCmd::Shutdown) {
            self.pins_shutdown.store(true, Ordering::SeqCst);
        }
        if let Ok(guard) = self.pins_tx.lock() {
            if let Some(tx) = guard.as_ref() {
                let _ = tx.send(cmd);
            }
        }
    }

    pub fn notify_shared_bans(&self, cmd: SharedBansCmd) {
        if matches!(cmd, SharedBansCmd::Shutdown) {
            self.shared_bans_shutdown.store(true, Ordering::SeqCst);
            super::shared_bans::shutdown();
        }
        if let Ok(guard) = self.shared_bans_tx.lock() {
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
            msg_id: None,
            timeout_remaining_sec: None,
        };
        let self_login = auth::resolved_login_token(self).map(|(l, _)| l);
        let sim = super::similarity::cfg_from_shared(self);
        let stack_style = super::timeout_stack::style_from_shared(self);
        let stream_id = super::logging::resolve_stream_id(self, channel);
        let mut logged: Vec<super::types::ChatEvent> = Vec::new();
        let batch = self.hub.lock().ok().and_then(|mut hub| {
            hub.ingest_logged(
                channel,
                event,
                self_login.as_deref(),
                &sim,
                stack_style,
                |ev| {
                    logged.push(ev.clone());
                },
            )
        });
        for ev in &logged {
            super::logging::try_log(self, channel, ev, &stream_id);
        }
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
        assert_eq!(
            wanted.channel.as_ref().map(|c| c.login.as_str()),
            Some("xqc")
        );
        assert_eq!(
            wanted.channel.as_ref().map(|c| c.room_id.as_str()),
            Some("999")
        );

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

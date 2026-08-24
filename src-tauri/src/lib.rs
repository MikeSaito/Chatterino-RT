mod chat;
mod security;

use chat::commands::{
    auth_import, auth_logout, auth_start, auth_status, chat_complete, chat_exec_custom_command,
    chat_join, chat_leave,
    chat_part, chat_search, chat_send, chat_snapshot, chat_subscribe, chat_user_profile,
    filters_get, filters_set, highlight_sound_pick, highlight_sound_read,
    highlight_cancel_attention, highlight_request_attention, logging_pick_directory, open_chat_link,
    session_get, settings_get, settings_set, streamer_mode_detect, supports_incognito_links,
};
use chat::link_resolver::resolve_link_info;
use chat::state::{BttvCmd, EventCmd, IrcCmd, Shared};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let shared = Shared::new();
    tauri::Builder::default()
        .plugin(security::freeze_app_prototype())
        .manage(shared.clone())
        .setup(move |app| {
            chat::auth::init(app.handle(), &shared)?;
            chat::filters::init(app.handle(), &shared)?;
            chat::session::init(app.handle(), &shared)?;
            chat::settings::init(app.handle(), &shared)?;
            chat::eventapi::start(shared.clone())?;
            chat::bttv_live::start(shared.clone())?;
            chat::live_status::start(app.handle().clone(), shared.clone());
            chat::shared_chat::start(shared.clone());
            chat::irc::start(app.handle().clone(), shared)?;
            security::allow_embed_storage(app);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            chat_join,
            chat_leave,
            chat_part,
            chat_snapshot,
            chat_subscribe,
            chat_send,
            chat_exec_custom_command,
            chat_complete,
            chat_search,
            chat_user_profile,
            session_get,
            open_chat_link,
            supports_incognito_links,
            resolve_link_info,
            auth_start,
            auth_status,
            auth_import,
            auth_logout,
            filters_get,
            filters_set,
            settings_get,
            settings_set,
            highlight_sound_read,
            highlight_sound_pick,
            logging_pick_directory,
            highlight_request_attention,
            highlight_cancel_attention,
            streamer_mode_detect
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app.try_state::<Shared>() {
                    if let Ok(guard) = state.irc_tx.lock() {
                        if let Some(tx) = guard.as_ref() {
                            let _ = tx.try_send(IrcCmd::Shutdown);
                        }
                    }
                    state.notify_event(EventCmd::Shutdown);
                    state.notify_bttv(BttvCmd::Shutdown);
                    chat::live_status::shutdown();
                    chat::shared_chat::shutdown();
                }
            }
        });
}

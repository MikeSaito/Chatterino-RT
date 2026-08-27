//! Chatterino RT — часть API намеренно зарезервирована под parity с Chatterino.
#![allow(dead_code)]

mod chat;
mod security;

use chat::commands::{
    about_info, auth_import, auth_logout, auth_remove, auth_select, auth_start, auth_status,
    cache_clear, cache_info, cache_pick_directory, chat_blocked_users, chat_complete,
    chat_emote_popup_list, chat_exec_custom_command, chat_join, chat_leave, chat_part, chat_search,
    chat_send, chat_set_user_blocked, chat_set_user_ignore_highlights, chat_snapshot, chat_subscribe,
    chat_toggle_favourite_emote, chat_user_blocked, chat_user_followers, chat_user_ignore_highlights,
    chat_user_profile, chat_profile_image, chat_user_pronouns, chat_user_notes, chat_user_subage, chat_set_user_notes,
    chat_viewer_role, chatterino1_commands_available, filters_get, filters_set, highlight_cancel_attention,
    highlight_request_attention, highlight_sound_pick, highlight_sound_read, image_upload,
    logging_pick_directory, open_chat_link, open_in_custom_player, open_in_streamlink,
    open_settings_directory, open_settings_window, read_chatterino1_commands, session_get, settings_get, settings_set,
    streamer_mode_detect, supports_incognito_links, fetch_emote_cdn,
};
use chat::link_resolver::resolve_link_info;
use chat::state::{BttvCmd, EventCmd, IrcCmd, Shared};
use tauri::{AppHandle, Manager};

/// Остановить фоновые IRC/7TV/BTTV/poll задачи перед выходом.
fn shutdown_background(app: &AppHandle) {
    if let Some(state) = app.try_state::<Shared>() {
        if let Ok(guard) = state.irc_tx.lock() {
            if let Some(tx) = guard.as_ref() {
                let _ = tx.try_send(IrcCmd::Shutdown);
            }
        }
        state.notify_event(EventCmd::Shutdown);
        state.notify_bttv(BttvCmd::Shutdown);
        chat::live_status::shutdown();
        chat::live_notifications::shutdown();
        chat::shared_chat::shutdown();
    }
}

/// Закрыть все окна и завершить процесс (скрытое settings иначе держит app alive).
fn quit_app(app: &AppHandle) {
    shutdown_background(app);
    if let Some(settings) = app.get_webview_window("settings") {
        let _ = settings.close();
    }
    app.exit(0);
}

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
            chat::user_data::init(&shared)?;
            chat::toast_shortcut::apply_from_settings(&shared);
            chat::eventapi::start(shared.clone())?;
            chat::bttv_live::start(shared.clone())?;
            chat::live_status::start(app.handle().clone(), shared.clone());
            chat::live_notifications::start(app.handle().clone(), shared.clone());
            chat::shared_chat::start(shared.clone());
            chat::irc::start(app.handle().clone(), shared)?;
            security::allow_embed_storage(app);
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                quit_app(window.app_handle());
            }
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
            chat_emote_popup_list,
            chat_toggle_favourite_emote,
            chat_search,
            chat_user_profile,
            chat_profile_image,
            chat_user_followers,
            chat_user_pronouns,
            chat_user_subage,
            chat_user_notes,
            chat_set_user_notes,
            chat_viewer_role,
            chat_blocked_users,
            chat_user_blocked,
            chat_set_user_blocked,
            chat_user_ignore_highlights,
            chat_set_user_ignore_highlights,
            session_get,
            open_chat_link,
            open_settings_directory,
            open_settings_window,
            fetch_emote_cdn,
            about_info,
            cache_info,
            cache_pick_directory,
            cache_clear,
            open_in_streamlink,
            open_in_custom_player,
            supports_incognito_links,
            resolve_link_info,
            auth_start,
            auth_status,
            auth_import,
            auth_logout,
            auth_select,
            auth_remove,
            filters_get,
            filters_set,
            settings_get,
            settings_set,
            chatterino1_commands_available,
            read_chatterino1_commands,
            highlight_sound_read,
            highlight_sound_pick,
            logging_pick_directory,
            highlight_request_attention,
            highlight_cancel_attention,
            image_upload,
            streamer_mode_detect
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            match event {
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
                    shutdown_background(app);
                }
                _ => {}
            }
        });
}

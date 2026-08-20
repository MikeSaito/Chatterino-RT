mod chat;
mod security;

use chat::commands::{
    auth_import, auth_logout, auth_start, auth_status, chat_join, chat_part, chat_send,
    chat_snapshot, open_chat_link,
};
use chat::state::{IrcCmd, Shared};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let shared = Shared::new();
    tauri::Builder::default()
        .plugin(security::freeze_app_prototype())
        .manage(shared.clone())
        .setup(move |app| {
            chat::auth::init(app.handle(), &shared)?;
            chat::irc::start(app.handle().clone(), shared)?;
            security::allow_embed_storage(app);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            chat_join,
            chat_part,
            chat_snapshot,
            chat_send,
            open_chat_link,
            auth_start,
            auth_status,
            auth_import,
            auth_logout
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
                }
            }
        });
}

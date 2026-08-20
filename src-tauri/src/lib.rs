mod chat;
mod security;

use chat::commands::{chat_join, chat_part, chat_snapshot, open_chat_link};
use chat::state::Shared;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let shared = Shared::new();
    let for_irc = shared.clone();
    tauri::Builder::default()
        .plugin(security::freeze_app_prototype())
        .manage(shared)
        .setup(move |app| {
            chat::irc::start(app.handle().clone(), for_irc)?;
            security::allow_embed_storage(app);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            chat_join,
            chat_part,
            chat_snapshot,
            open_chat_link
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app.try_state::<Shared>() {
                    if let Ok(guard) = state.irc_tx.lock() {
                        if let Some(tx) = guard.as_ref() {
                            let _ = tx.try_send(chat::irc::IrcCmd::Shutdown);
                        }
                    }
                }
            }
        });
}

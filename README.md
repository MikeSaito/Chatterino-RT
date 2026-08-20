# WebTV_chats

Гибридный клиент Twitch-чата на Tauri 2: Rust принимает IRC, один WebView рисует чат (PixiJS) и embed.

```text
npm install
npm run tauri dev
```

Необязательно в `.env` рядом с процессом: `TWITCH_OAUTH_TOKEN`, `TWITCH_LOGIN`. Без них анонимный read (`justinfan`). Картинки бейджей и cheermotes: ещё `TWITCH_CLIENT_ID` вместе с токеном (Helix только в Rust).

# Chatterino RT

Гибридный клиент Twitch-чата на Tauri 2: Rust принимает IRC, один WebView рисует чат (PixiJS) и embed.

```text
npm install
npm run tauri dev
```

Необязательно в `.env` рядом с процессом: `TWITCH_OAUTH_TOKEN`, `TWITCH_LOGIN`. Без них анонимный read (`justinfan`). Вход по кнопке Войти идёт через страницу Chatterino (`chatterino.com/client_login`) и их публичный Client ID. Свой `TWITCH_CLIENT_ID` нужен только чтобы заменить этот поток.

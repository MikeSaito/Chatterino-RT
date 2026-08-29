![Chatterino RT](public/logo.png)

Chatterino RT [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
============

Chatterino RT is a chat client for [Twitch.tv](https://twitch.tv).
It reimplements [Chatterino 2](https://github.com/Chatterino/chatterino2) as a [Tauri 2](https://v2.tauri.app/) desktop app: Rust owns IRC, emote catalogs, and filters; one WebView draws chat with [PixiJS](https://pixijs.com/) and an optional Twitch player embed.

This project is not affiliated with Chatterino. It does not copy C++/Qt sources or Chatterino assets. Overlay windows, plugins, and EventSub are out of scope for v1.

## Download

Pre-built Windows installers are published on [GitHub Releases](https://github.com/MikeSaito/Chatterino-RT/releases).

Download **`Chatterino.RT_*_x64-setup.exe`** (NSIS). The installer embeds the WebView2 bootstrapper when the runtime is missing.

After install: join a channel (anonymous read works); use **Войти** for send. Right-click an emote and check **Open** / **Copy** submenus for 1x–4x CDN links.

## Building

Windows 10/11 is the current target.

### Prerequisites

- [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with **Desktop development with C++**
- [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) (already present on Windows 11)
- [Rust](https://www.rust-lang.org/tools/install) via rustup (stable)
- [Node.js](https://nodejs.org/) LTS

Full OS notes: [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/).

To get the source and install JS dependencies:

```shell
git clone https://github.com/MikeSaito/Chatterino-RT.git
cd Chatterino-RT
npm install
```

Run in development:

```shell
npm run tauri dev
```

Build a release bundle:

```shell
npm run tauri build
```

## Login

Without credentials the client joins as anonymous (`justinfan`) and can only read chat.

The in-app **Войти** button opens Chatterino's public login page (`https://chatterino.com/client_login`) and uses their public Client ID. Paste the resulting login blob back into the app.

Optional `.env` next to the process (see `.env.example`):

- `TWITCH_OAUTH_TOKEN`
- `TWITCH_LOGIN`
- `TWITCH_CLIENT_ID` (only if you replace the Chatterino login flow with your own Twitch application)

## Code style

Rust lives in `src-tauri/` and is formatted with [rustfmt](https://github.com/rust-lang/rustfmt). TypeScript and PixiJS live in `src/`.

## Validation

```shell
cd src-tauri
cargo fmt --check
cargo test
cd ..
npm run typecheck
npm test
npm run build
```

GitHub Actions (`CI` workflow) runs four required jobs on `main`, pull requests, and merge groups: `rustfmt`, `Rust tests`, `JS tests` (typecheck + unit), and `Production build`.

`npm test` runs all files in `tests/*.test.ts`. Per-file runners remain as `npm run test:*` for debugging.

## License

MIT. See [LICENSE](LICENSE).

Chatterino 2 is also MIT. Protocol and UX logic follow that project; C++/Qt code and assets are not included.

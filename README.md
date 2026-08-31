<p align="center">
  <img src="public/logo.png" alt="Chatterino RT" width="168" height="168" />
</p>

<h1 align="center">Chatterino RT</h1>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT" /></a>
  <a href="https://github.com/MikeSaito/Chatterino-RT/releases"><img src="https://img.shields.io/github/v/release/MikeSaito/Chatterino-RT?label=release" alt="Release" /></a>
  <a href="https://github.com/MikeSaito/Chatterino-RT/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/MikeSaito/Chatterino-RT/ci.yml?branch=main&label=CI" alt="CI" /></a>
</p>

<p align="center">
  Twitch chat client for Windows. Hybrid <a href="https://v2.tauri.app/">Tauri 2</a> app: Rust owns IRC, emote catalogs, and filters; one WebView renders chat with <a href="https://pixijs.com/">PixiJS</a> and an optional Twitch player embed.
</p>

Reimplements [Chatterino 2](https://github.com/Chatterino/chatterino2) behavior under MIT. Not affiliated with Chatterino. Does not copy C++/Qt sources or Chatterino assets.

## Download

Windows installers: [GitHub Releases](https://github.com/MikeSaito/Chatterino-RT/releases).

Use **`Chatterino.RT_*_x64-setup.exe`** (NSIS). The package embeds the WebView2 bootstrapper when the runtime is missing.

After install: join a channel (anonymous read works). Use **Sign in** / **Войти** to send messages. Right-click an emote for **Open** / **Copy** CDN size links (1x–4x).

In-app updates use the same Releases feed (`latest.json`) after a draft release is published.

## Building

Target: Windows 10/11.

### Prerequisites

- [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with **Desktop development with C++**
- [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) (included on Windows 11)
- [Rust](https://www.rust-lang.org/tools/install) (stable via rustup)
- [Node.js](https://nodejs.org/) LTS

OS notes: [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/).

```shell
git clone https://github.com/MikeSaito/Chatterino-RT.git
cd Chatterino-RT
npm install
```

Development:

```shell
npm run tauri dev
```

Release bundle (local; updater signing needs `TAURI_SIGNING_*` env if `createUpdaterArtifacts` is enabled):

```shell
npm run tauri build
```

Tagged releases (`v*`) are built by [`.github/workflows/release.yml`](.github/workflows/release.yml): NSIS installer, signed updater artifacts, draft GitHub Release. Publish the draft so clients can reach `releases/latest/download/latest.json`.

## Login

Without credentials the client joins as anonymous (`justinfan`) and can only read chat.

In-app sign-in opens Chatterino's public login page (`https://chatterino.com/client_login`) with their public Client ID. Paste the resulting login blob back into the app.

Optional process environment (see [`.env.example`](.env.example); not loaded from a Vite `.env` into Rust):

- `TWITCH_OAUTH_TOKEN`
- `TWITCH_LOGIN`
- `TWITCH_CLIENT_ID` (only when replacing the Chatterino login flow with a custom Twitch application)

## Layout

| Path | Role |
| --- | --- |
| `src-tauri/` | Rust: IRC, HTTP emote lists, disk, filters, `ChatBatch` |
| `src/` | TypeScript / PixiJS UI and input |
| `tests/` | JS unit tests (`npm test`) |

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

CI on `main` / PRs: `rustfmt`, Rust tests, JS typecheck + unit tests, production build.

## Community

- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Contributing](CONTRIBUTING.md)
- [Security Policy](SECURITY.md)

## License

MIT. See [LICENSE](LICENSE). Chatterino 2 attribution: [NOTICE](NOTICE).

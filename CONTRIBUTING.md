# Contributing

Thanks for helping improve Chatterino RT.

This repository is the Tauri app published as [MikeSaito/Chatterino-RT](https://github.com/MikeSaito/Chatterino-RT). It reimplements Chatterino 2 behavior under MIT; do not copy C++/Qt sources or Chatterino assets.

## Development setup

Prerequisites and commands are in [README.md](README.md).

```shell
npm install
npm run tauri dev
```

## Before opening a pull request

Run the same checks as CI:

```shell
cd src-tauri
cargo fmt --check
cargo test
cd ..
npm run typecheck
npm test
npm run build
```

## Pull requests

- Keep changes minimal and focused on one concern.
- Prefer English for commit messages and PR titles (why, not a file list).
- Never commit secrets, `.env` files, private keys, or real OAuth tokens. Use `YOUR_API_KEY_HERE` stubs.
- Do not weaken CSP (`*` is forbidden), enable `dangerousInsecureTransportProtocol`, or add `withGlobalTauri: true`.
- UI must not open Twitch IRC sockets or call Helix / BTTV / FFZ / 7TV JSON APIs; that stays in Rust.
- New invoke commands need serde validation and `Result` with an error body (not HTTP status tricks).

## Issues

Use the GitHub issue templates for bugs and feature requests. Include OS version, app version, and steps to reproduce when reporting a bug.

## License

By contributing, you agree that your contributions are licensed under the MIT License ([LICENSE](LICENSE)).

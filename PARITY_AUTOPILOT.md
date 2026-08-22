# Parity autopilot queue

Cloud Agent reads this file each run. Repo root = `tauri-app` on GitHub (`MikeSaito/Chatterino-RT`). Product name: **Chatterino RT**.

## Architecture (do not violate)

- Rust: IRC, HTTP emoji lists, disk, filters, `ChatBatch`, OAuth, Helix where already used.
- JS: Pixi render, settings UI, one `PIXI.Application`, one WebView, one window `main`.
- Chat live path: MessagePack via `chat_subscribe` / `chat_snapshot` only. No IRC/Helix from UI except image CDN URLs from Rust package.
- Secrets from env only. No `*` in CSP. No TODO stubs.
- Do not port Chatterino Qt windows (`Window`, `Notebook`, `BasePopup`, `OverlayWindow`).
- Reimplement Chatterino logic; MIT notice when borrowing behavior.

## One run = one atomic slice

1. Read this file. Pick the **first unchecked** queue item below.
2. If blocked (needs Mentions UI, overlay v1-exclude, or >1 day scope), mark `[skip: reason]` and take the next item.
3. Implement end-to-end: Rust and/or JS so the knob is **wired** (settings persist + runtime effect).
4. Run validation:
   - `cargo test` (relevant modules)
   - `npx tsc --noEmit`
   - `npm run test:wrap` / `test:scroll` if UI metrics touched
5. Internal critic pass: security, edge cases, no scope creep.
6. Commit (English message, why not what) and **push to `main`**.
7. Update this file: check the item, add one line under **Changelog**, note next item.
8. Stop. Do not start a second slice in the same run (avoids push loops stacking badly).

## Commit rules

- Git root is repo root (all files here). Never commit `.cursor/` (not in repo).
- Atomic commits. English only. Push after commit unless run was triggered by your own push (still push once at end).

## Exclusions (never implement in autopilot)

- Mentions channel UI (`showInMentions` stays until Mentions exists)
- Overlay / frameless always-on-top (`v1-exclude`)
- Notebook / multi-split tabs UI
- Plugins tab runtime
- FFZ live WebSocket (stock has none)

## Priority queue

Check front to back. `[ ]` = todo, `[x]` = done, `[skip: …]` = deferred.

### General / Messages (small, high value)

- [ ] `general.fadeMessageHistory` — reduce opacity of scrolled history in MessageRing
- [ ] `general.hideMessageTimestampsWhenLive` — hide timestamps while channel live
- [ ] `general.collapseMessagesMinLines` — limit message height (collapse)
- [ ] `general.deletedMessageLengthLimit` — truncate deleted message text

### General / Emotes

- [ ] `behaviour.emoteCompletionWithColon` — `:` emote completion in composer
- [ ] `behaviour.useSmartEmoteCompletion` — smarter completion ranking
- [ ] `emotes.showEmoteTooltip` — hover tooltip on emotes
- [ ] `emotes.emoteTooltipScale` — tooltip size
- [ ] `emotes.emoteTooltipDelay` — tooltip delay ms

### General / Interface

- [ ] `general.tabLayout` — persist only until TV layout needs it; wire if trivial read path exists
- [ ] Remaining Interface `persist` rows — see settings catalog labels in `src/settings/catalog.ts`

### SearchPopup

- [ ] Search predicate mini-language (`from:`, `regex:`) in `chat_search`
- [ ] Clear button on search input

### Ignores (large slice — one item per run max)

- [ ] Twitch blocked users list via Helix — `filters.twitchBlockedUsers` or stock-equivalent path

### Advanced General (pick one knob per run)

- [ ] Link preview toggles block
- [ ] Sound / AppData cache knobs
- [ ] Advanced search / overlay / badge toggles — one jsonPath per run

## Changelog

| Date | Slice | Commit |
| --- | --- | --- |
| (autopilot fills) | | |

## Key paths

| Area | Path |
| --- | --- |
| Settings schema + catalog | `src/settings/`, `src/shell/settings/` |
| Rust chat core | `src-tauri/src/chat/` |
| Filters / highlights | `src-tauri/src/chat/filters.rs` |
| Message ring | `src/chat/MessageRing.ts` |
| IPC | `src/chat/ipc.ts` |
| Stock reference (read-only, not in repo) | Chatterino 2 `src/controllers`, `src/messages`, `src/providers/twitch` |

# Workspace and delivery (1.1.6)

Each channel keeps its message text, reply ID/author/preview, and cursor selection.
Switching tabs restores that channel's composer. A successful send clears its
original draft only if its content/reply revision still matches, including when
the user has switched away. Editing and reverting the text creates a new revision.

Drafts and reading anchors are saved locally in the main WebView under the
versioned `crt-workspace-v1` key, with coalesced writes and a flush on blur,
visibility loss, page exit, and tab changes. Existing Rust `session.json` keeps
open channel order and the active channel. Closed tabs are removed from the saved
workspace. Corrupt data is ignored; failed writes keep the in-memory draft and
report the save failure. Retention is limited to 20 channels.

Reading position uses message ID plus a fractional offset within that message.
After reopening, available history restores the same anchor. If that message has
fallen out of the available history, a two-second grace period allows history to
arrive, then the view restores its distance from the bottom within available
content. User scrolling cancels the pending restoration. Full chat history and
pending outgoing messages are not persisted or automatically replayed.

The status strip belongs to the active channel and shows its latest send attempt:

| State | Meaning |
| --- | --- |
| Queued / sending | IPC is pending; IRC has not yet finished its socket write. |
| Accepted by Twitch | Helix returned `is_sent=true` with the Twitch message ID. |
| Sent via IRC | Socket write completed; Twitch acceptance cannot be confirmed through IRC. |
| Command processed | The command handler completed. Any command-specific result is shown in chat. |
| Send failed | Definitive rejection/cancellation; Retry sends the original text/reply to the original channel without replacing a newer draft. |
| Delivery unknown | The write/HTTP response failed after sending may have started. Check chat before manually sending again. No Retry shortcut is shown. |

Queued IRC sends expire after 30 seconds before their write starts. The queue's
cancellation/start lock prevents a timed-out message being sent later. An already
started write waits for its own eight-second socket timeout. Leaving a channel
or changing account cancels its queued messages. Uncertain socket writes and
Helix POST requests are never replayed automatically.

# Performance checks

Run `npm run test:browser` with an installed Chromium browser. On Windows the
runner detects Chrome or Edge; `CRT_BROWSER_PATH` can select an executable. It
launches an isolated temporary browser profile, the local Vite server on port
1420, and CDP on port 9224. Both ports must be free. It leaves the user's regular
browser profile untouched.

The fixture loads the actual app, Pixi renderer, composer handlers, workspace
storage, and IPC decoder/pump. Tauri commands/events are mocked, so no chat
messages are sent to Twitch. Checks cover independent drafts/replies, reading
anchors, background send completion, edits during sends, retry, uncertain writes,
closing an inactive tab, and page restart. It then feeds encoded MessagePack
batches at 50 and 200 messages/sec, with a third 200/sec run while scrolling.

Output is written to `artifacts/browser-performance.json` and a UI screenshot.
The load checks assert that every generated event reached the actual IPC/ring and
that measurements exist; timing values are reported without a hardware-dependent
pass/fail threshold. CI and release workflows run these checks.

For measurements in the actual desktop WebView, enable the existing debug hook
with `localStorage.setItem('crt-debug', '1')`, reload, then run:

```js
window.__crt.performance.start();
// Read an active channel; scroll normally.
window.__crt.performance.stop(); // Returns the report.
```

The report contains processing and layout/scroll timings, frame interval
percentiles, long-frame count (relative to a configurable frame budget), received
message count/rate, and JavaScript heap start/end/peak when the engine exposes it.
`receiptToFrame` estimates local IPC arrival to the renderer's next intervening
frame using two animation-frame callbacks. It is not Twitch network latency or a
GPU presentation measurement. Heap values exclude native Rust/GPU allocations;
unavailable memory is `null`. Reports contain no message text, logins or tokens.
Collection is opt-in, with bounded samples and pending callbacks.

The local synthetic baseline uses Chromium headless with SwiftShader, 1280×800,
DPR 1. It exercises text messages with short/long lines; it is not a benchmark of
animated emotes, video playback, or a production WebView on a hardware GPU.
At 200 messages/sec the measured layout work is the main CPU cost; use repeated
runs in the target WebView to assess optimization and real scroll smoothness.

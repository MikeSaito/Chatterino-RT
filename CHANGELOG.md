# Changelog

## 1.1.6

- Keep independent message drafts, reply targets, and cursor selections for each channel.
- Restore drafts and reading positions after restart, alongside the existing open-channel and active-tab restoration.
- Show per-channel send status with retry of the original failed message while preserving newer edits.
- Wait for the actual IRC socket write before clearing an accepted draft; label IRC sends as unconfirmed by Twitch.
- Cancel queued sends after 30 seconds or channel/account changes. Do not replay an uncertain IRC write or Helix POST after a lost response.
- Add bounded, opt-in performance measurements for message processing, time to the next renderer frame, frame intervals, layout/scroll work, and available JavaScript heap usage.
- Add browser integration checks for tab switching, asynchronous sends, retries, reply restoration, tab closure, and restart, plus reproducible 50/200-message-per-second load checks in CI and release validation.

## 1.1.5

- Preserve message drafts and reply targets when sending fails or the draft is edited during an in-flight send.
- Bind composer sends to the channel selected when submitting the message.
- Report Helix send failures and rate-limit rejections to the composer instead of treating them as success.
- Keep Twitch message IDs for messages sent through Helix so replies and deletion events address the correct message.
- Pace queued IRC messages with the shared account rate limiter, including after reconnecting.
- Retry failed chat IPC subscriptions automatically and recover messages received during the outage.
- Add regression coverage for draft preservation, production IPC recovery, Helix results, and IRC queue pacing.

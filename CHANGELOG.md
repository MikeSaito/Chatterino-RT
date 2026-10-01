# Changelog

## 1.1.5

- Preserve message drafts and reply targets when sending fails or the draft is edited during an in-flight send.
- Bind composer sends to the channel selected when submitting the message.
- Report Helix send failures and rate-limit rejections to the composer instead of treating them as success.
- Keep Twitch message IDs for messages sent through Helix so replies and deletion events address the correct message.
- Pace queued IRC messages with the shared account rate limiter, including after reconnecting.
- Retry failed chat IPC subscriptions automatically and recover messages received during the outage.
- Add regression coverage for draft preservation, production IPC recovery, Helix results, and IRC queue pacing.

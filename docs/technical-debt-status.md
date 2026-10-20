# Technical debt implementation status

Implemented:

- Scroll chrome owns and cancels all DOM subscriptions, scroll callback, pending
  animation frame, timeout and resize observer. Disposal is idempotent and releases
  pointer capture. An older binding cannot clear a newer binding's scroll callback
  or pause state.
- `npm run test:contract` exports JSON and MessagePack through Rust's real
  `ChatBatch` and encoder, checks the reviewed golden JSON and compares every
  decoded value using the production TypeScript decoder. All eleven event kinds,
  nested notices, optional fields, Unicode and damaged packets are covered. CI and
  draft release builds run this command. Update the golden only after reviewing
  the Rust and TypeScript contract changes together.
- Send completion orchestration lives in `composerDelivery.ts`; pure row formatting
  lives in `rowFormatting.ts`. Remaining controllers and renderer resources have
  not yet been extracted.
- `npm run test:performance-gate -- report.json` compares measured runs. The input
  is an array of scenario groups, each containing `calibration` (five runs),
  `baseline` (three runs), and `candidate` (three runs). Required scenario names:
  `50-emotes`, `200-emotes`, `200-scroll-emotes`. Each run has `environment`, `build`,
  `scenario`, `generated`, `processed`, `crashed`, and `metrics`: `processingP95Ms`,
  `frameP95Ms`, `longFrameRatio`, `privateBytes`, `memoryGrowthBytes`.
  Memory means private bytes of the entire application process tree, not JS heap.
  Growth is the end minus the post-warmup value. Reports must contain finite
  measurements; unavailable required measurements cannot pass the gate.
  Relative scatter is the median absolute deviation divided by the calibration
  median. Candidate medians must not exceed the baseline by max(15%, three times
  scatter); when the calibration median is zero, the absolute deviation is used.

Not implemented or validated yet:

- Local Windows test isolation on the existing release PC, installed-app
  smoke/persistence/update automation and the Rust test-only message source.
- Two-minute warmup / 30-minute hardware scenario collection on the existing PC, animated local emote
  assets, environment fingerprint collection and release integration of the gate.
  The comparison utility alone does not make hardware checks mandatory for release.
- Installer metadata, cryptographic updater verification, checksums and public
  post-publication verification as permanent release steps.
- Full channel/auth/moderation extraction and row interaction/resource controllers.

The existing short browser load test remains unchanged and continues to check
message delivery and measurement availability, without timing thresholds.

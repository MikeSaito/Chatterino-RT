# Technical debt implementation status

## Completed

- Scroll lifecycle cleanup and reviewed Rust/TypeScript JSON + MessagePack contracts
  are covered by tests and CI.
- Release builds remain drafts. They now download and verify all NSIS/MSI assets,
  embedded versions, updater signatures using the baked production public key,
  GitHub digests when provided, and SHA-256. Authenticode is checked separately;
  unsigned releases remain supported, but mixed/invalid signatures fail.
- A published-release workflow checks the public manifest, each installer and the
  actual updater download. Reports and SHA256SUMS are retained on workflow failure.
- The `validation` Rust feature provides an offline source through the actual
  parser, channel buffers, MessagePack encoder, Tauri Channel and renderer. It is
  absent from normal builds. The validation app requires its own product identity,
  ignores Twitch environment credentials, and never starts the network workers.
- Native smoke checks cover real Rust invocations, process restart, local settings,
  channels, drafts, animated emote decoding and private memory of the process tree.
  The installer runner refuses ordinary production installers.
- The local upgrade check installs two validation packages, serves a signed update
  over loopback, installs it through the real updater and verifies the new version
  and persisted state. A disposable key is used; production keeps HTTPS and its
  original baked public key. This tests the update mechanism on two versioned
  validation packages, not historical release source compatibility.
- Auth operations, serialized channel lifecycle and moderation dispatch now have
  separate controllers with disposal. Row text formatting, pointer-to-text mapping
  and nickname paint GPU resource ownership are separated from MessageRing.
- Unit tests no longer write the user's Windows autorun registry entry.

## Local Windows commands

```powershell
npm run test:release -- --tag v1.1.7 --public
npm run build:validation -- --debug
npm run test:installed -- --installer "src-tauri/target/debug/bundle/nsis/Chatterino RT Validation_1.1.7_x64-setup.exe"
npm run test:upgrade:prepare
npm run test:installed -- --installer artifacts/validation-upgrade/validation-1.1.6.exe --update-installer artifacts/validation-upgrade/validation-1.1.7.exe
```

Test profiles, reports, installers and disposable keys stay under ignored
`artifacts/`. The validation app has its own Windows settings directory; test
installations have their own install directories and product registration.
Ordinary app data and login are not copied. Test installation artifacts are kept
for inspection; use their own uninstaller to remove the Validation product.

## Long performance runs — skipped at the owner's request

No long-run performance result or regression baseline is claimed. These runs do
not block releases when no evidence file is supplied.

The optional tools are ready: build committed baseline and candidate sources in
release mode using `npm run build:validation`, keep both executables, then run:

```powershell
npm run test:hardware-suite -- --baseline-exe <baseline.exe> --candidate-exe <candidate.exe>
```

The suite performs five calibration, three baseline and three candidate passes.
Each pass has 50/s, 200/s and scrolling 200/s scenarios with local animated emotes,
120 seconds of warmup and 1800 seconds of measurement per scenario (about 18 hours
in total). Reports contain frame/processing percentiles, process-tree memory,
post-warmup growth, texture/frame counts, source revision and environment identity
(CPU, GPU/driver, WebView2, display, settings, power plan and fixture hash). GPU
allocation bytes are unavailable and reported as null. A changed environment or
uncommitted/debug build cannot establish a baseline.

`npm run test:performance-gate -- <comparison.json> --release` checks complete
measurements and flags candidate regressions beyond max(15%, three times the
relative median absolute deviation of calibration). Missing messages and crashes
fail. An optional `release-evidence/vX.Y.Z.json` committed for a tag is enforced by
the release workflow and must match the candidate revision. Omitted evidence is
explicitly reported as skipped. Existing short browser checks remain mandatory.

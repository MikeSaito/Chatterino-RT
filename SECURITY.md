# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 1.1.x | Yes |
| 1.0.x | Best effort |
| older | No |

## Reporting a vulnerability

Do **not** open a public issue for security problems.

1. Prefer [GitHub private vulnerability reporting](https://github.com/MikeSaito/Chatterino-RT/security/advisories/new) for this repository.
2. Include: affected version/tag, impact, reproduction steps, and any proof-of-concept (no mass exploitation).
3. Allow a reasonable time for a fix before any public disclosure.

We will acknowledge valid reports and coordinate disclosure when a fix or mitigation is ready.

## Scope notes

- OAuth tokens and signing keys must never be committed. Report accidental secret exposure immediately.
- Chat links are opened in the OS browser after http(s) validation; that design matches Chatterino and is intentional.
- Auto-update trust is the updater public key baked into the binary plus signed GitHub Release artifacts.

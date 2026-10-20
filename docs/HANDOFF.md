# Halcyon — project handoff

Status as of 2026-10-20. This document lets a new developer or AI session continue without the original conversation.

## 1. Original requirements (from the product owner)
> Create a complete email, calendar and contacts app to replace Microsoft Outlook, for use with multiple IMAP/SMTP
> emails. It must natively work with AI and different providers, including self-hosted Ollama. Define all functions
> necessary to be competitive with the best on the market and develop the software. It should work both in the browser
> and as a native app on Windows. The web app should be hostable on an Ubuntu server and should perform AI tasks in the
> background so that when the user asks, the result is already ready. Plan and develop the complete functionality automatically.

Derived requirements / design decisions:
| Requirement | How it is met |
|---|---|
| Multiple IMAP/SMTP accounts | Per-account sync workers, unified inbox, cross-account move, aliases, per-account signatures |
| Replace Outlook (mail+calendar+contacts) | Calendar with CalDAV + iMIP, contacts with CardDAV, tasks, rules, templates, Outlook-like 3-pane UI, mailto handler |
| AI native, many providers incl. Ollama | Provider adapters: ollama, openai, openai-compatible, anthropic, gemini (+ hidden `mock` for tests/demo); per-task routing; privacy mode |
| AI ready before user asks | Durable background queue: analyze (summary/priority/category/actions/events/smart replies/phishing), thread summaries, embeddings, pre-written reply drafts, daily brief (generated 30 min before `briefTime`) |
| Browser + native Windows | React SPA served by the server; Electron app (local mode forks server; remote mode loads server URL); NSIS installer |
| Host on Ubuntu | `deploy/install-ubuntu.sh` (Node 22, systemd hardening, nginx + certbot, optional Ollama), Docker Compose |
| Multi-user web hosting | Users table, admin user management, scrypt passwords, sessions, all data scoped by `user_id` |

## 2. Current state
- 4 commits of working code (~8,900 lines) + this handoff. All features in `docs/FEATURES.md` are implemented.
- Tests: 32/32 passing — `server/test/unit.test.js` (provider wire protocols incl. streaming, vCard, ICS/DST, search parser, sanitizer),
  `e2e.test.js` (real Dovecot IMAP + local SMTP relay + mock AI: sync, threading, sanitising, background AI, search, flag/move/archive/trash
  round-trips, IDLE, send/undo/schedule, replies, invitations/RSVP, recurrence & exceptions, ICS/vCard/CSV, rules, folders, encryption),
  `dav.test.js` (real Radicale: pull, push create/update/delete, contact push, remote change pull; skipped unless `TEST_DAV_URL`).
- UI verified in Chromium via Playwright (setup, account wizard, inbox, reader, AI reply, compose, search, calendar week/month,
  contacts, tasks, assistant, settings, dark mode, mobile layout) with zero console errors.
- Desktop verified: Electron 44 on Linux (local server, desktop-token auth, mailto deep link); Windows installer
  `Halcyon-Setup-1.0.0.exe` (≈121 MB) built on Linux; packaged Windows server + SQLite + IMAP sync verified under Wine.
  The installer is a build output (not in git) — rebuild with `npm run dist:win` or the *Desktop builds* GitHub workflow.

## 3. Not verified yet (do these first on real infrastructure)
1. Real AI models (Ollama, OpenAI, Anthropic, Gemini) — only protocol-level fakes + mock were used. Check JSON reliability of
   `analyzePrompt` with small local models (llama3.1:8b, qwen2.5:7b) and tune prompts/temperature.
2. Google / Microsoft OAuth (needs app registration; redirect `<HALCYON_PUBLIC_URL>/api/oauth/callback`).
3. Real Gmail / Microsoft 365 / iCloud mailboxes (Gmail label folders, `[Gmail]/All Mail` disabled by default, M365 throttling).
4. Windows installer on real Windows (install, tray, toast notifications, taskbar badge, Default apps → Email registration). Unsigned → SmartScreen warning.
5. `deploy/install-ubuntu.sh` end-to-end on a fresh Ubuntu 24.04 VM (only syntax + install steps checked); Docker image build.
6. Performance with large mailboxes (100k+ messages): initial sync, window-function list query, in-memory vector index memory.

## 4. Known gaps / roadmap (prioritised)
1. Code signing + auto-update for desktop (electron-updater with a generic provider, e.g. served by the Halcyon server).
2. S/MIME and OpenPGP (sign/encrypt/verify).
3. Microsoft Graph / Exchange (EWS) connector for tenants with IMAP disabled; Google Calendar/People API alternative to DAV.
4. Shared mailboxes, delegation, other people's free/busy, room booking.
5. PWA service worker for offline web use; IndexedDB cache.
6. UI internationalisation (UI is English; AI output already follows the chosen language).
7. Two-way IMAP draft sync (drafts are local + optional "save to server").
8. Vector index persistence/ANN (e.g. sqlite-vec) for very large mailboxes.
9. Per-user AI budget limits; admin view of global AI usage.
10. Message templates with variables; mail merge; read receipts handling UI; conversation muting.

## 5. Architecture essentials (details: docs/ARCHITECTURE.md)
- SQLite DB `data/halcyon.db` + raw `.eml` store `data/mail/<accountId>/<sha1>.eml`. Master key: `HALCYON_SECRET` or `data/secret.key` — losing it makes stored credentials unreadable.
- Sync: `mail/sync.js` `AccountSync` per account; full cycle every `HALCYON_POLL_INTERVAL`s, INBOX IDLE push; `pending_ops` replay; UIDPLUS uid remap; orphan reconciliation for permanently failed moves.
- Pipeline after ingest (`mail/pipeline.js`): contacts collect → rules (non-AI) → enqueue `analyze` (inbox, within `analyzeDays`) + `embed` → WS `mail:new`.
- AI queue (`ai/queue.js`): statuses queued/running/done/failed/waiting; `waiting` = no provider (resumed when one is added/settings change). Handlers: analyze, thread, embed (batched 32), draft, brief.
- Focused inbox = no insight yet OR (priority ≥ 40 and category not newsletter/promotion/social/notification) OR priority ≥ 70.
- Real-time events over `/api/ws`: mail:new, mail:changed, folder:synced, sync:state, ai:insight, ai:thread, ai:draft, ai:brief, reminder, outbox:changed, calendar:changed, contacts:changed, tasks:changed.
- Desktop local mode: server forked with `ELECTRON_RUN_AS_NODE`, `HALCYON_SINGLE_USER=1`, random port, `HALCYON_DESKTOP_TOKEN` cookie required → other local processes get 401.
- better-sqlite3 v13 ships Node-API prebuilds for all OSes → no native rebuild for Electron; bundle is platform-independent (script prunes other platforms).

## 6. Lessons / gotchas discovered during development
- electron-builder drops a *top-level* `node_modules` in extraResources → bundle lives at `desktop/server-bundle/server/`.
- electron-builder needs an exact Electron version and `publish: []` (otherwise "reading 'channel'" error).
- Building NSIS on Linux needs both `wine64` and `wine32:i386`, and a `wine` wrapper on PATH (`/usr/lib/wine/wine`).
- `@fastify/static` must use `wildcard: true`, otherwise a rebuilt UI is not served until restart.
- `trustProxy` is restricted to loopback by default; `true` would allow spoofing `X-Forwarded-For` (bypassing single-user/loopback checks and login throttling).
- Address parsing: plain `a@b.c` must be checked before `Name <addr>` (greedy regex bug).
- Radicale reorders ICS properties — tests must not assume order.
- Tests use an ephemeral SMTP port; node:test runs each file in its own process (config is read at import time).

## 7. Environment used for development/testing
- Node 22, Ubuntu container. Dovecot test IMAP on 127.0.0.1:1143 (users alice@test.local / bob@test.local, password secret123) via `server/test/setup-dovecot.sh`.
- Radicale on 127.0.0.1:5232 (alice/secret123) via `server/test/setup-radicale.sh`.
- Demo/UI testing: start server with `HALCYON_DEMO=1` to expose the `mock` AI provider type; seed mail with `rfc822()` + `append()` from `server/test/helpers.js`.

## 8. Product owner
Igor Vaskivskyi (igor.vaskivskyi@ijs.si), Jožef Stefan Institute. Repository: github.com/vaskivskyiI/halcyon.

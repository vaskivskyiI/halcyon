# CLAUDE.md — guide for AI coding sessions on Halcyon

Read this first, then `docs/HANDOFF.md` (full project state, requirements, decisions, known gaps, roadmap).

## What this is
Halcyon: self-hostable, AI-native replacement for Microsoft Outlook — email (multiple IMAP/SMTP accounts),
calendar (CalDAV, iMIP invitations), contacts (CardDAV), tasks, and an AI layer (Ollama / OpenAI / Anthropic /
Gemini / OpenAI-compatible) that precomputes insights in the background. One codebase → web app (Ubuntu server /
Docker), Windows desktop (Electron), Linux/macOS desktop.

## Layout
- `server/` Node.js ≥20, ESM, plain JavaScript (no TypeScript, no build step). Fastify 5, better-sqlite3 13 (WAL, FTS5),
  ImapFlow, Nodemailer, mailparser, tsdav, ical.js, rrule, sanitize-html.
  - `src/index.js` app bootstrap (`buildServer()`), WebSocket `/api/ws`, static web UI
  - `src/config.js` all env vars · `src/db/schema.js` migrations (append new entries, never edit shipped ones)
  - `src/mail/` sync engine (`sync.js`), ingest (`store.js`, `pipeline.js`), actions, send/outbox, OAuth, autoconfig
  - `src/ai/` providers (`providers/*`), router (per-task routing, privacy mode), queue (durable job queue), tasks (handlers), assistant (RAG chat), vectors (semantic index), prompts
  - `src/calendar/`, `src/contacts/`, `src/routes/` (REST), `src/rules.js`, `src/search.js`, `src/scheduler.js`
- `web/` React 18 + Vite, no UI library; global store in `src/store.js`; hash routing (`#/mail/<view>/<id>`, `#/calendar`, `#/contacts/<id>`, `#/tasks`, `#/assistant`, `#/settings/<section>`, `#/compose?url=mailto:…`)
- `desktop/` Electron 44 shell (`main.js`, `preload.js`, `connect.html`), `scripts/bundle-server.mjs`, electron-builder config in `package.json`
- `deploy/` Ubuntu installer, systemd unit, nginx · `Dockerfile`, `docker-compose.yml` · `.github/workflows/`

## Commands
```bash
npm install                      # workspaces: server, web, desktop
npm run build                    # web UI → web/dist (server serves it)
npm start                        # server on :8080
npm run dev                      # server --watch + Vite on :5173 (proxy /api)
sudo ./server/test/setup-dovecot.sh && ./server/test/setup-radicale.sh
TEST_DAV_URL=http://127.0.0.1:5232/alice/ npm test     # unit + ai (no IMAP needed) + e2e IMAP/SMTP + DAV
./deploy/podman-pod.sh up --with-ollama                # server as a podman pod
npm run dist:win                 # Windows installer (on Linux needs wine64 + wine32:i386)
```

## Conventions
- Match surrounding style: 2-space indent, single quotes, semicolons, compact functions, sparse comments that explain *why*.
- DB access through `db/index.js` helpers (`get/all/run/tx/update`); timestamps are epoch ms; JSON columns end with `_json`.
- Every user-scoped query must filter by `user_id` (multi-user server). Lists, search and AI retrieval must also honour the
  active space: `const sc = scope(userId, reqSpace(req))` and `inIds(column, sc?.accountIds | calendarIds | bookIds)` (`spaces.js`).
- New content the assistant should know about gets indexed with `queueMemory(userId, kind, ref)` (`ai/queue.js`).
- AI must never delete, spam or send/forward mail by itself: such actions from AI-driven paths go through `ai_approvals` (see `rules.js`).
- Mail actions: apply locally first, then `queueOp(accountId, op, payload)`; never talk to IMAP from routes.
- Long AI work goes through `enqueue(userId, type, refId, priority)` + `registerHandler`; push results with `notify(userId, type, payload)`.
- Streaming AI endpoints use `streamNdjson` (server) / `stream()` (web `api.js`).
- Secrets are stored with `encrypt()`; never return them from the API.
- After changing the web UI run `npm run build`; after changing behaviour add/extend tests in `server/test/`.
- Do not put model identifiers in code comments/commits beyond provider defaults in `ai/providers/index.js`.

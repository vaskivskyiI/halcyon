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

### 2026-10-20 session: AI safety, privacy, background analysis, podman, desktop modes
- **AI may not delete/send on its own.** Rules whose conditions use AI output (category / priority / needsReply)
  still run harmless actions (mark read, flag, label, move/archive), but `trash`, `spam`, `forward` and moves into
  Trash/Junk become rows in `ai_approvals` (migration 2) that the user approves/dismisses in the mail list banner
  (`GET/POST /api/ai/approvals`). Rationale: email content steers the model (prompt injection), so a crafted mail could
  otherwise trigger a forward (exfiltration) or deletion. Non-AI rules and user-clicked actions are unchanged. The
  assistant has no tools; AI drafts are only ever inserted into the composer. Covered by `server/test/ai.test.js`.
- **Background analysis**: the queue itself worked (checked on a real desktop DB: 28/28 inbox mails analysed), but
  the reader claimed "Analysis queued…" for mail that is never queued (sent, >30 days, other folders) — looked broken.
  Now `messages.ai_status` ∈ pending | waiting (no provider) | failed | done | none (not scheduled) and the reader says
  which. `backfillAnalysis()` (pipeline.js) queues eligible mail with no insight and no job — on start (+15 s), every
  15 min, when a provider is added and when AI settings change. Job claiming is atomic (embed batches could
  double-claim), batch-claimed jobs clear stale errors, "Analyze now" waits for a running background job instead of
  analysing twice. iMIP REPLY/CANCEL processing moved from the AI handler to ingest (worked only with AI on).
- **Privacy/security**: calendar CANCEL accepted only from the event organizer, REPLY only updates the sender's own
  attendance (previously anyone could cancel meetings); session tokens no longer accepted in `?token=` (leak via logs/
  history); global Content-Security-Policy (also applies to the srcdoc email iframe: no scripts, no remote fonts);
  `cid:` images served with a sandbox CSP (scripted SVG); AI providers on plain http to non-LAN hosts are flagged
  `insecure` and warned about in Settings → AI.
- **Deploy**: `npm ci` ran node-gyp for better-sqlite3 (despite prebuilds) and failed without python/make → Dockerfile
  and installer use `--ignore-scripts`. New `deploy/podman-pod.sh` (pod with Halcyon + optional Ollama, env file with
  the secret, systemd unit generation). Not run here — no podman on the dev machine.
- **Desktop**: two modes, exactly one does sync+AI: "This PC — local AI" (Foundry Local on the NPU / Ollama / LM Studio,
  auto-detected via `GET /api/ai/local-detect`; the shell passes Foundry's dynamic port as `HALCYON_FOUNDRY_URL`) or
  "Halcyon server" (no local server started; reachability checked before loading). Windows arm64 build
  (`npm run dist:win-arm64`) for Snapdragon Surfaces. Not built/run on Windows in this session.

### 2026-10-20 (later): AI memory and spaces
- Requirement: efficient AI search/chat over email content; multi-user server; one user with several accounts (work,
  private) must be able to use them together or separately — also for calendars and contacts.
- Implemented `memory` + `facts` tables (migration 3, replaces `embeddings`), `ai/memory.js` (int8 in-RAM index per
  active user, idle eviction, owner-key scoping), chunked email indexing, thread/event/contact/fact memory,
  `spaces.js` + `/api/spaces`, `x-halcyon-space` header handled by mail/calendar/contacts/AI routes, per-space brief
  and chats, "remember that …" in the assistant, Settings → Spaces and Settings → AI → Memory. Tests:
  `server/test/memory.test.js` (scoping never crosses spaces or users, dedupe, deletion).
- Also fixed: `index.html` was cached for 1 h (users kept an old UI after upgrades); the prepared-statement cache was
  unbounded (dynamic SQL on a long-running multi-user server).
- Decisions: unassigned items are *shared* (visible in every space) so a single local calendar keeps working; tasks are
  not split by space (tasks created from mail follow that mail's space in brief/assistant); free/busy is computed over
  all calendars. With a real embedding model the assistant ranks by relevance with a low score floor (0.1) because
  models differ in their similarity baseline — check retrieval quality with nomic-embed-text on real mail.
- Scale notes: brute-force int8 scan is fine to a few hundred thousand passages per user; beyond that add an ANN index
  (roadmap item 8). Embedding volume grows ~2–3× vs. one vector per mail (≤ 6 passages per email).

### 2026-10-20 (evening): feedback from first real use
- Search/chat "never answered": the user's Ollama was saturated (even a trivial request did not finish in 280 s).
  Now: Ollama is called with `think: false` (thinking models spent minutes/whole token budget on hidden reasoning;
  `<think>` blocks from OpenAI-compatible servers are stripped); per-provider lanes in `ai/router.js` let interactive
  requests (chat, search query embedding, writing, "analyze now", brief refresh) go first while background work waits
  and keeps ≤1 request in flight per self-hosted provider; embedding batches of 16; chat streams status lines and fails
  after 90 s without a first token; search is two-phase (instant keyword results, then `/api/search/semantic`).
- Sent mail is analysed (own commitments, other half of conversations; never "needs reply", low priority).
- `ai_insights.expires_at` (migration 4): model-provided or detected for login/verification codes; a 2-minute sweep
  drops expired items to priority ≤10 and clears needs-reply.
- Event times: prompts ask for local date + HH:MM; `util/time.js` converts with the user's time zone (models wrote
  12:30Z for a 12:30 meeting → shown 14:30).
- Chat lists all emails given to the model as clickable sources (cited ones first).
- `requested_items` from analysis → `findRequestedEmails()` (keyword + semantic, same space, older mail) → reader shows
  candidates with "Forward to <sender>" (opens the composer; nothing is sent automatically).
- Learning (`ai/learning.js`, table `ai_feedback`): important / not important / category / spam corrections per sender
  (domain after two agreeing corrections, not for public mail domains); applied as hard preferences and as few-shot
  examples in the analysis prompt; spam-marked senders are filed to Junk at ingest (user's own rule). Reviewable in
  Settings → AI → Memory.
- Not verified against the real model (Ollama was unresponsive): prompt changes (events/expires/requested_items) need a
  check with qwen2.5:7b-instruct on real mail.

### 2026-10-20 (night): safety and workflow round (user runs the server version with real mail)
- No accidental destruction: archive/delete/spam/move return an undo snapshot; "restore" moves mail back and cancels a
  move the IMAP server has not seen yet (`restoreMessages`, `runningOps` in sync.js). "Delete" on mail in Trash/Junk
  never deletes implicitly (server no longer does it in `trashMessages`); permanent deletion is only the explicit,
  confirmed `delete`. Confirmations added for event deletion, "run rule now", unsubscribe, task deletion.
- Composer marks the quoted/forwarded part (`data-quote`); AI rewrite and drafting only touch the user's text.
- Reader: attachment chips under the header; quoted history folded (HTML: Gmail/Outlook incl. Slovenian headers/
  Apple/Thunderbird; plain: "On … wrote:", ">" lines); long threads fold middle messages.
- Brief: live lists (`briefLive`) with ✓ Done (`ai_insights.dismissed_at`, migration 5), task checkboxes, quick add;
  the AI overview is short and refreshed in the background after important mail / task changes (≤ every 15 min);
  opening the brief never waits for the AI.
- Dynamic AI views: `ai_insights.topic` (prompt reuses existing topics; `normalizeTopic`), sidebar Topics + AI
  categories with counts; list rows distinguish unread / read / important / expired, show topic and "replied".
- Drag a message onto the Calendar icon → prefilled event (AI extraction, manual fallback), onto Tasks → tasks.
- Queue bug fixed: a delayed job (back-off, brief refresh) could make new jobs wait up to 60 s (`kick()`).
- podman-pod.sh: `update` does `git pull --ff-only`, re-executes the new script, reuses options saved by `up`.

### 2026-10-21: sync, recipients, older mail, status
- Bug: "Sync now" (`trigger()` without folder) synced nothing until the 2-minute cycle; now it requests a full cycle,
  and work arriving during a sync is not deferred (`hasPendingWork`). The UI waits for the sync to finish, refreshes
  and reports errors. Without a WebSocket connection (proxy not passing /api/ws upgrades) the UI warns and polls every 30 s.
- Focused/Other re-query when an analysis arrives. Analysis knows how the user is addressed (`addressingOf`: sole / To
  with others / CC / not addressed incl. aliases); not addressed → never "needs reply", priority ≤ 55 unless the
  sender is a favourite or marked important.
- Settings → AI: analyse older mail (period, missing-only or all, low priority) and Stop (`/api/ai/cancel`).
- Quote detection moved to `server/src/util/quotes.js` (used by the reader and by `stripQuoted` for prompts):
  Slovenian/German/French attributions, wrapped lines, Outlook header blocks; sanitizer keeps `data-quote`.
- Settings → Accounts: live IMAP status (connected, IDLE push, last full sync, folder errors), pending/failed server
  operations, last SMTP result, outbox problems, "Test connection" for saved accounts (`/api/accounts/status`, `/test`).
- AI accent colour changed from purple to teal; AI summaries in the list use normal text colour.

### 2026-10-21 (later): drafts, replies, style, tasks
- Drafts: the composer's × used to *discard* (delete) the draft. Now × asks Save / Delete / Cancel (empty drafts close
  silently); "Save draft" also writes one copy to the IMAP Drafts folder, replacing the previous copy via a
  `deleteByMessageId` op that only matches the draft's own Message-ID (`drafts.server_msgid`, migration 6). Sending or
  deleting a draft removes the server copy. Draft replies are shown on their message/thread (`related.drafts`) and as a
  "Draft" chip in the list; Reply/Reply all continue an existing draft. Quick reply: Reply / Reply all, autosaved as a
  draft (`quick: true` in the payload, local only), Undo after send, now includes the quoted original.
- "Needs reply" set/cleared by the user (`POST /api/messages/needs-reply`, bulk) is stored in `needs_reply_user` and
  survives re-analysis and expiry.
- Reader shows tasks/events created from the conversation (`related.tasks/events`).
- Old-mail analysis can be "quiet" (job option, `ai_jobs.options_json`): no needs-reply, dismissed from brief/priority.
- Style: `styleExamples()` (sent mail to the same recipient, else same non-public domain) in draft/compose prompts;
  weekly `style` job writes `settings.ai.learnedStyle`. The user's own "Writing style" text takes precedence.
- Tasks in plain language: `util/dates.js` (en/sl, tz/DST aware) with AI fallback (`aiParseTask`); preview while typing.
- Unread/Focused/Other keep the open message in the list until the user moves to another one.

### 2026-10-22: threads, action needed, time awareness, mail history
- Sent mail is stored in the local Sent folder right after delivery (matched by Message-ID when the server copy syncs),
  so replies show in their conversation at once; Sent folder found by name if the server has no SPECIAL-USE.
- `ai_insights.needs_action` / `action_summary` (migration 7): "Action needed" view, chip, brief section, `is:action`.
- Search: `topic:` operator, filter row in the UI; category/topic chips open their views.
- Assistant: "Now" in the user's time zone, every item dated with relative age, past events labelled/omitted,
  "what should I do" answered from `briefLive()`, mail older than 3 weeks ignored for such questions.
- Mail history (migration 8): the first sync still takes the last 90 days / 2000 newest per folder quickly; older mail
  is then downloaded in batches (`backfillHistory`, HALCYON_HISTORY_BATCH) back to `accounts.sync_history`
  ('90' | '365' | 'all'), set in Settings → Accounts, which also shows downloaded vs. on-server counts.

### Next round: time zone, counts, sending, tasks, calmer list
- Time zone: `calendar.tzAuto` (default on) — the web client sets `calendar.timezone` to the browser's zone (a server in a
  container runs in UTC, which shifted AI-read times by the UTC offset). Changing the zone re-zones stored insight events /
  `expires_at` keeping their wall-clock time (`rezone()` in util/time.js, settings route).
- Sidebar counts use the list's own filter (`scopeFor`) and count conversations: unread for mailboxes, open items for
  Needs reply / Action needed / Snoozed. The web refreshes counts after its own changes (`halcyon:mutated`), not only on
  socket events (which may not pass a proxy).
- Sending: delivery starts when the undo window closes (timer in `queueSend`), the original is flagged `\Answered` /
  `$Forwarded` (migration 9, `is_forwarded`) right after SMTP; the client refreshes after the expected send time.
- Failed server changes store the IMAP server's text (`responseText`) and folder; `append` to a missing folder
  (TRYCREATE) creates it and retries once; Settings → Accounts has Retry / Dismiss per failed change.
- History download searches each folder once (cached UIDs) instead of every batch.
- List sorting: `sort=date|from|subject|size|unread|flagged&dir=asc|desc`, offset paging when not newest-first.
- Tasks from mail: `GET /api/tasks/from-message/:id` proposes title with the sender + context body (from, date,
  subject, summary) + due in the user's zone; the web dialog edits them before `POST`. Task list: details (notes), ⋯ /
  right-click menu with due presets (today, tomorrow, in N days, next Monday, …), edit dialog.
- Calmer list: one accent for unread/important, neutral outlined chips, category/"Draft ready" chips removed from rows,
  Outlook-style replied/forwarded icons before the subject.

### Round after: new mail, threading, speed, time zones (migration 10)
- New mail: `syncFolder` always searches `last_uid+1:*`. It used to trust `mailbox.uidNext`, which is only refreshed on
  SELECT — the Inbox stays selected for IDLE, so new mail was skipped until something re-selected it.
- History download: a folder that fails 3× is marked done (it kept "downloading older mail…" forever); the status
  names the folders still pending.
- `append` (sent copy / draft): on any failure the real server folder list is checked; a missing folder → the server's
  own `\Sent` / `\Drafts`, else it is created; errors without server text say so. Failed appends get one more try per
  restart.
- Threading: `subject_key` (util/subject.js: reply/forward prefixes in many languages stripped, [tags] kept). When
  reply headers do not connect a message, it joins a conversation with the same key, a shared participant (not the user)
  and within 45 days; originals only join replies. `regroupConversations()` regroups existing mail once
  (`app_state` 'regroup:v1').
- Speed: lists newest-first walk `idx_messages_list` (index only: bodies are stored inline, so row reads are
  expensive), then load 50 rows; counts use `idx_messages_folder_unread`; `PRAGMA optimize` at start and every 6 h;
  lookups at ingest got `(user_id, message_id)` / `(user_id, in_reply_to)` indexes. Web: last list per view/tab shown
  instantly with its scroll position, opened conversations cached, tab per view remembered, each section reopens
  where the user left it (`lastRoute` in App.jsx), calendar keeps its date.
- Tab counts: `GET /api/messages/tab-counts` (unread conversations for Focused / Other / All).
- No accidental re-analysis: messages removed by sync (expunge, UIDVALIDITY, folder gone, stale moves) keep their
  analysis a week in `insight_archive` by Message-ID and get it back when they reappear; mail deleted by the user keeps
  nothing. A folder must be missing from two listings before it is dropped locally.
- Time zones: the container runs in the host's zone (`TZ`, podman-pod.sh / compose). Models no longer convert times:
  they return `tz` as stated in the mail and `zoneOf()` maps it ("CET" → Europe/Paris with DST, "GMT+1", IANA).
  Invitations use their own times (`extractEvent` reads the ICS); floating ICS times use the user's zone.

## 3. Not verified yet (do these first on real infrastructure)
0. This session's changes were tested with unit tests + `ai.test.js` + the web UI in a browser (demo data, mock AI);
   `e2e.test.js`/`dav.test.js` were not run (no Dovecot/Radicale available) — run them before release. Podman script,
   Foundry Local detection and the arm64 installer are untested on real hardware.
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
- `npm ci` without `--ignore-scripts` needs python3 + make for better-sqlite3 even though prebuilds are used.
- Tests use an ephemeral SMTP port; node:test runs each file in its own process (config is read at import time).

## 7. Environment used for development/testing
- Node 22, Ubuntu container. Dovecot test IMAP on 127.0.0.1:1143 (users alice@test.local / bob@test.local, password secret123) via `server/test/setup-dovecot.sh`.
- Radicale on 127.0.0.1:5232 (alice/secret123) via `server/test/setup-radicale.sh`.
- Demo/UI testing: start server with `HALCYON_DEMO=1` to expose the `mock` AI provider type; seed mail with `rfc822()` + `append()` from `server/test/helpers.js`.

## 8. Product owner
Igor Vaskivskyi (igor.vaskivskyi@ijs.si), Jožef Stefan Institute. Repository: github.com/vaskivskyiI/halcyon.

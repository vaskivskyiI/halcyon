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

### Sent mail / drafts on the server, problems never silent (migration 11)
- Bug fixed: `reconcileOrphans` deleted local sent copies (uid NULL) once their append had failed 5× — sent mail
  vanished locally ("not found"). Copies made by Halcyon are now `messages.local_copy = 1` until the server copy is
  matched by Message-ID and are never cleaned up; `notOnServer` in the API, "Not on server" chip / reader banner,
  `POST /api/messages/save-to-server` ({ids} | {all}). Append ops carry `localId`; when the server's own Sent folder is
  used instead, the local copy moves along.
- Sent / Drafts found by special-use or localised names (`mailFolder()` in send.js, e.g. "Poslani elementi",
  "Osnutki"); folders Halcyon creates are subscribed (most clients hide unsubscribed folders).
- Drafts are stored on the server automatically (`syncDraftsToServer`, every 30 s for drafts unchanged for 30 s;
  `drafts.server_saved_at`); the new copy is appended before the old one is deleted.
- `GET /api/status/problems` + `components/Problems.jsx`: red indicator in the rail with a panel (reconnect, retry /
  dismiss failed server changes, send again / save as draft, save unsaved sent mail on the server); new errors toast
  once; a send error opens the panel. `POST /api/outbox/:id/to-draft`; failed outbox items can be edited/cancelled.
- Outbox rows left 'sending' by a restart become 'failed' with an explanation (never resent automatically).

### Time zone, end to end (migration 13)
- Every web request carries `x-halcyon-tz`; `requireUser` → `noteClientTimezone()` sets `calendar.timezone` when
  `tzAuto` is on (so a server/container in UTC is corrected by any open tab, not only at page load).
- `timezoneChanged()` (settings.js) keeps the wall-clock time of what the server read in the old zone: insight events,
  `expires_at`, and open tasks whose `due_tz` is the old zone (server-computed: typed "tomorrow at 10", dates from
  mail) or older unedited tasks from mail. Times picked in the browser (`due_tz` NULL) never move.
- A zone the model returns for an event counts only if the email text mentions it as a word (`statedIn`); events
  store `read: { date, time, tz }` (shown on hover). Settings → Preferences shows the zone used, device and server zone.

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

### Extra read-only calendars, overlap note (migration 14)
- ICS links (Google / Outlook "secret iCal address", webcal, holidays): `POST /api/calendars {url}` loads the link first
  (wrong links are refused with the reason), refresh every 30 min, `calendars.sync_error` shown in the problems panel;
  events are kept while a link fails.
- Read-only CalDAV servers that are not a mail account: `calendar_sources` (url, user, encrypted password) →
  `syncCalendarSource()` = `syncCalDav(pseudoAccount, { sourceId, readonly: true })`; all calendars found there,
  `readonly = 1`, never pushed. `/api/calendar-sources` (list / add / refresh / delete). Errors → problems panel.
- Read-only is enforced for update / delete / occurrence edits / moving into a read-only calendar (repo.js); events
  from `listRange` carry `readonly` and `calendarName`; the week view does not drag them.
- Event editor: overlap note (other busy, timed events in the chosen time, all calendars) with "Find a free time".
- dav.test.js and round12 (read-only source) were run against Radicale (pip --user install in WSL; no venv there).
- `calendars.show_as` (migration 15): 'busy' | 'free' | 'info'. `listRange` sets each event's effective `busy`
  (event busy AND calendar busy) and `showAs`; `{ includeInfo: false }` for the daily brief / live brief / reminders;
  the assistant sees info/free events labelled. Web: "Show events as" in the calendar's menu and when adding,
  free = light with coloured edge, info = faint dashed, "Show informational events" toggle (per device).
- `findFreeSlots` works in the user's zone (it used the server's setHours/getDay) and offers starts every 30 min,
  at most 4 per day.

### Google accounts
- OAuth client from env (GOOGLE_/MICROSOFT_CLIENT_ID/SECRET) or, if not set, saved by an administrator in
  Settings → Accounts (`oauthClient()` / `saveOAuthClient()` in mail/oauth.js; app_state 'oauth:<provider>', encrypted).
  `/api/admin/oauth` (GET status + redirect URI, PUT client). The dialog explains the Google Cloud / Entra steps
  (Google: publish the consent screen, otherwise refresh tokens expire after 7 days; enable CalDAV + CardDAV APIs).
- Redirect URI honours X-Forwarded-Proto/Host (nginx terminating TLS) unless HALCYON_PUBLIC_URL is set.
- Add account → Google: sign-in (mail + calendar + contacts via CalDAV/CardDAV OAuth) or app password (Gmail IMAP/SMTP
  presets) + optional secret iCal address as a read-only calendar. OAuth accounts that fail offer "Sign in again".
- Not tested against real Google (no client in CI): the sign-in redirect is tested; token exchange and Google
  CalDAV/CardDAV need a real account.

### On behalf of, invitations (migration 16)
- `messages.sender_json`: the Sender header when it differs from From and is not a list / bounce address
  (`actingSender` in store.js); older mail is filled in when opened (`senderOf`). API `onBehalfOf`; reader header
  "Sender on behalf of From" + "Sent by … — replies go to …"; list row "· sent by …".
- Invitations that are only calendar data show the event description (+ location) as the message (`inviteText`, at
  ingest and when shown). `parseIcs` repairs raw line breaks inside values before giving up.
- Accept / Maybe / Decline each offer: send the response now, add a note then send, or don't send (calendar only);
  the API already took `sendReply` / `comment`.
- Requested actions are settled as 'done' or 'skipped' ("Not doing it"): `ai_insights.resolution` (migration 17)
  with `dismissed_at`; reader shows which and when, with Undo; list menu "Action: done / not doing it";
  search `is:done`, `is:skipped`.
- round16 checks that every `api.<method>()` used in web/src exists in web/src/api.js (an `api.put` call broke the
  OAuth setup dialog).
- Invitation detection (`findIcs` in store.js): text/calendar, application/ics, .ics/.vcs names, calendar data
  recognised by content in text / octet-stream parts, and inside forwarded messages (message/rfc822, 2 levels).
  `calendar_ics = ''` means checked, none; NULL (older mail) is re-checked when opened (`icsOf`). `invitationFor`
  returns `{ error }` instead of null when the data cannot be read; the card then offers "Add to calendar (read from
  the text)" and `/api/messages/:id/invitation.ics`.
- Identities: replies go out from the address the message was sent to (`receivingIdentity` in Composer.jsx: an
  account address or alias among the recipients, also when another account's inbox received it), else the account it
  is stored in; the From selector lists every address incl. aliases. New mail defaults to `store.focusAccountId`
  (message being read / folder of one account). Server: From must be the account's address or an alias.
- Overlap check: `/api/events?allSpaces=1` (events of every space, with `space`).
- Calendar: wheel in month view, sideways swipe / Shift+wheel in every view move through time (throttled).
- OAuth sign-in window: BroadcastChannel / storage event / postMessage(origin) back to the app (Google's pages cut
  window.opener), then closes itself or asks to be closed; the Add-account dialog closes on success.
- CalDAV push: tsdav returns the HTTP response instead of throwing; refused writes used to count as saved, and the next
  sync then deleted the local event (accepted invitations "disappeared"). Now: non-2xx (except 404 on delete) → stays
  dirty, `calendars.sync_error` → problems panel; events with href but no etag that the server does not list (by href
  or UID) are re-saved, not deleted; file names are sanitised UIDs. Accepting returns calendar/space/start → toast
  with "Show" (opens the calendar on that day, switching space if needed).
- CI: `npm test` = all offline tests (round16 checks every test file is in a script); `npm run test:servers` = e2e
  (Dovecot) + dav + round19 (Radicale), a separate job with continue-on-error; failures become ::error annotations
  (server/test/gh-reporter.mjs), readable via the public API without the logs. desktop.yml had invalid YAML
  (`{…,deb}` in a flow mapping) and failed on every push.
- Radicale for local runs without root: pip --user (see scratch notes); Dovecot needs root, so e2e has not been run
  locally.
- First CI annotations: only e2e "flags, move, archive and trash propagate" failed — it expected a second "trash" to
  delete permanently, which the safety rules forbid; it now checks that, then uses the explicit "delete".
- Invitations: `inviteCalendar()` (invites.js) = account's chosen calendar (`accounts.invite_calendar_id`, migration
  18, Settings → Accounts) else the account's own writable calendar (default, else main name, not Birthdays & co.),
  else its space's / the default. The card has an "Add to / In" calendar picker (`calendarId` on respond; answering
  again with another calendar moves the event).
- Moving events between calendars (`moveToCalendar` in repo.js): master + overrides copied (new server copy created),
  old server copy marked deleted+dirty so the next sync deletes it there. Right-click on an event → "Move to calendar".
- CalDAV pull updates events in place (same UID/occurrence keep their id) instead of delete + insert.

### AI context: people, the user, direct summaries (migration 19)
- `ai/profiles.js`: `contact_profiles` per correspondent (who / relationship / organisation / topics / language /
  how the user writes to them / their style / notes) built by job 'profile' from the mail exchanged (the user's own mails
  with greeting and sign-off) + facts; `user_notes` are the user's corrections, always first and authoritative.
  Counted on ingest (`noteCorrespondence`, robots and the user's own addresses skipped); built when ≥2 mails, rebuilt
  after 5 new or monthly; `seedCorrespondents` + `scheduleProfiles` for existing mail. Used in analysis (sender /
  recipients), draft replies and new mail ("how the user writes to them"), and the assistant (PEOPLE section for
  people named in the question and senders of the found emails). API `/api/people/:email` (+ `/notes`, `/refresh`);
  UI `components/PersonProfile.jsx` in the AI card and in Contacts.
- Job 'aboutme' (monthly): `settings.ai.learnedAboutMe` from sent mail + facts, in every request after the user's own
  "About you"; editable in Settings → AI. Settings `contactProfiles`, `learnAboutMe`.
- Summaries: prompt asks for the substance (no subject restatement, no "X writes…"); `ai/summary.js cleanSummary`
  removes the openings models still produce. Thread summaries likewise.
- Composer: AI changes can be undone step by step ("Undo AI", toast with Undo).
- Mark as read moved to the Reader (all unread messages shown in the conversation, after markReadAfterMs); the list
  updates through `halcyon:read`. Selected rows stay highlighted when unread (CSS order bug).
- Test helpers that wait for an idle AI queue ignore jobs scheduled for later (profile builds are delayed 5 min).

### Open items you can trust (audit, migration 20)
- `ai/open-items.js` is the single definition of "needs reply" / "action needed" for views, counts, tab counts, list
  labels (`openChecker`), search (`is:needsreply`, `is:action`) and the brief: not handled, not expired, recent
  (`ai.openItemsDays`, default 14; the user's own marks 2×), and for AI guesses: priority ≥ `ai.openMinPriority`
  (40; actions 60% of it) and not newsletter/promotion/social/notification. "Important" view: last 30 days, no noise.
- Replies: `markReplied` on every ingested mail from the user (any client/account): earlier messages from others in
  the conversation → resolution 'replied', `resolved_by`; the message replied to gets \Answered. One-time history
  pass (`app_state` 'replied:v1'). Across conversations: when sent mail is analysed, `openRequestsFor` (open items from
  its recipients / its conversation, 30 days) go into the prompt and the model returns `resolves` → `resolveByAi`.
  Incoming mail is analysed with recent mail with the same people from other conversations (`relatedMail`).
- AI can be wrong: everything closed automatically shows why ("Answered by your email …") with "Still needs a reply"
  / "Still open"; "Not an action" (resolution 'wrong'). Corrections are feedback kinds reply/noreply/action/noaction;
  two in a row for a sender → applyPreference clears needs_reply / needs_action for that sender's new mail.

### Send once, drafts in place, who asked whom, mobile (no migration)
- Sending is idempotent: the composer / quick reply send a `sendKey` (one per compose window); `queueSend` returns
  the queued row for a repeated key (24 h), or for a byte-identical payload within 60 s when no key is sent. The UI
  also ignores a second click while a send is in flight.
- Drafts are editors inside the conversation (`Composer` with `inline`): Halcyon drafts of the conversation
  (`related.drafts`, now the full payload + `serverMsgid`) and messages in the Drafts folder (`isDraft`), loaded via
  `GET /api/messages/:id/draft` (`draftFromMessage`: raw body, inline images as data URIs, attachments embedded).
  The first save adopts it (`saveDraft` with `serverMessageId` → `drafts.server_msgid` = its Message-ID), so the next
  save replaces exactly that server copy and sending removes it. Reply on a message with a draft focuses that editor.
- Conversation view: a message counts as unread when any of its copies is (Inbox + All Mail / Archive), so opening
  the conversation marks all copies read.
- Analysis context: THE EMAIL is analysed with the earlier conversation (up to 5 messages, `conversationContext`;
  or the history quoted inside the email when nothing earlier is stored), every message labelled "X → THE USER"
  (`whoWrote`, the user's addresses incl. aliases = `ownAddresses`), plus explicit rules on who asked whom. Thread
  summaries and AI reply drafts get the same labels. One-time re-analysis of currently open items
  (`reanalyzeOpen`, app_state 'reanalyze:context:v1'); re-analysis keeps the user's marks and the resolution.
- Mobile: modals/menus/toasts/suggestions are limited to the screen width (`.modal.wide` used to be 760 px wide);
  the full-screen composer sits above the bottom bar (its Send button was covered).

### Read-only sessions, diagnostics (migration 21)
- `sessions.read_only`: chosen at sign-in ("Read-only session" checkbox, `login { readOnly: true }`) or via Settings →
  Security → "Make this session read-only" (`POST /api/auth/read-only`; no way back except signing out). Enforced in
  an `onRequest` hook in index.js (`readOnlyBlocks` in auth.js): every non-GET request is refused with 403
  `{ readOnly: true }` except login/logout, plus GETs that start work (`wait=1`, `refresh=1`, `/api/oauth/*`); the
  browser time-zone update is skipped. The web UI shows a "Read-only session" pill and does not auto-mark read.
- Settings → Diagnostics (`GET /api/diagnostics`, routes/diagnostics.js): sync/pending ops/outbox per account (no
  addresses), folders, open items and how they were closed (by you / your reply / the AI), analysis by category,
  corrections, AI queue/failures/call timings, settings that matter, and request timings per route
  (util/metrics.js, in memory). Error texts are redacted (`redact`). Meant to be copied and shared.

### Findings from the live instance (read-only session) → second opinion, fewer requests
- Live data (Diagnostics): small local model (7B) — even with conversation context it flags "she will reply" as
  needs-reply, turns reminders into tasks, invents deadlines; sent mail rarely got `resolves`; duplicate / repeated
  requests; reminders of past events stayed open; folders were reloaded ~35×/min and problems ~20×/min.
- `ai/verify.js`: after analysis, mail flagged needs-reply/action gets a focused second prompt that must quote the
  sentence asking THE USER; kept only if the quote is really in the email's own text (`quoted`). Actions that are
  only "attend"/"add to calendar" are dropped (`notATask`); automated senders (`isAutomated`) never need a reply.
  For the user's sent mail each open request is checked one by one (`resolveCheck`), unioned with `resolves`.
  One-time re-analysis of open items: app_state 'reanalyze:verify:v1'.
- `supersededSql`: a newer Inbox mail from the same sender with the same subject_key that was flagged the same way
  supersedes older ones (repeats, duplicates across accounts); also in list labels (`ai_superseded_*` columns).
- Event mail (automated or calendar/notification/security/social/promotion/shopping) expires 1 h after its last event.
- Web: `loadFolders` coalesced (one in flight, ≥2 s apart); folders/problems reload on sync only when it is idle/error;
  problems at most every 5 s. Tab counts in one query. cleanSummary strips "X asks you/<user> to" only (needs "to").

### Shared spaces (migration 22)
- A shared space is a user of kind 'shared' (nobody signs in as it; not listed in Settings → Users) that owns the
  shared mail account, calendar, address book and tasks. Members (`shared_members`, role owner|member) act as it:
  `POST /api/shared/:id/enter` sets the `halcyon_as` cookie; `requireUser` (auth.js `actingAs`) then sets
  `req.user` = the shared user and `req.person` = the member, after checking membership on every request.
  `/api/auth|admin|shared` always act as the person. So all existing user-scoped code works unchanged, the data is
  synced and analysed once, and the AI context there is built only from shared data (no personal aboutMe / style).
- shared.js: createShared (copies AI providers + AI/calendar/mail settings, not personal ones), members, and moving
  between owners keeping all derived data: `moveAccount` (messages, insights, thread summaries if the whole thread
  moves, memory/facts by owner key, feedback, approvals, tasks from its mail, drafts, outbox, rules, labels remapped,
  its CalDAV/CardDAV calendars & books; sync worker restarted), `moveCalendar`, `moveAddressBook`, `moveTasks`;
  `fixDefaults` keeps a default calendar on both sides and drops the space's empty starters.
- Per person inside a space: `ui` and `notifications` settings (routes/settings.js), assistant chats (`chats.author_id`).
- WebSocket: a member's socket also gets the space's events, tagged `as`; the web app routes them to `onOtherEvent`
  (desktop notification for new mail there, unread count on the space switcher). Switching reloads the app.
- Web: space switcher lists "My mail" and shared spaces; pill "Shared: <name>"; Settings → Sharing (create, members,
  move in / out); task menu "Share in …".

### MCP server for other assistants (migration 23)
- `POST /api/mcp` (mcp/server.js): MCP over streamable HTTP with JSON responses (initialize, ping, tools/list,
  tools/call; notifications → 202; GET/DELETE → 405). Auth: `Authorization: Bearer hmcp_…` — `mcp_tokens` (sha256
  hash, per assistant; user_id = the person, target_id = own user or a shared space they are a member of, re-checked on
  every call; optional own space label; access 'read' | 'propose'), 120 calls/min, every call in `mcp_log` (last 500).
- Read tools: search_mail, get_message (text as `text_untrusted`), get_conversation, list_open_items, get_brief,
  list_events, search_contacts (with AI profiles), list_tasks. Propose tools: create_draft (saved, never sent),
  create_task, propose_mail_action (archive/trash/spam/mark_read/flag/move/forward → `ai_approvals` with rule_id
  NULL, rule_name = assistant name + reason; executed only via the user's approval). No tool sends or removes mail.
- Settings → Assistants (MCP): create keys (shown once, with Claude Code / mcp-remote config), activity log, revoke.
  `/api/mcp-tokens` always acts as the person. The approvals dialog now names assistants and all action types.

### Corrections with a reason (migration 24)
- `ai_feedback.reason`: after 👍 / 👎 / category change the reader offers "why?" (optional). A reasoned correction is
  a rule for the AI, not a sender preference: `senderPreference` / domain preferences / `listPreferences` ignore it, so
  genuine mail from the same sender is judged on its own. `preferenceExamples(userId, m)` puts the best-fitting
  reasoned rules (`reasonedRules`: same sender/domain, shared words with the corrected email + reason, recency) first
  as "RULES THE USER EXPLAINED", then plain corrections. Saving a reason re-analyses similar inbox mail of the last
  14 days (`similarRecent`, ≤30). Settings → AI → "Your rules": edit / delete (`/api/ai/rules`).

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
  14 days (`similarRecent`, ≤30). Settings → AI → "Your rules": edit / delete (`/api/ai/rules`). "Suggest" in the
  why-box: `POST /api/messages/:id/suggest-reason` (`suggestReason`: features of the email as a rule for similar mail;
  prefilled, saved only when the user saves).

### Batch: robustness, per-account context, own categories (migrations 25-26)
- Sending: `deliver` only sends (stable Message-ID per outbox row, kept across retries); `processOutbox` marks sent
  right after SMTP accepts, then `afterDelivery` (flags, Sent copy, contacts) whose failures are only logged; 5xx →
  failed at once; refused recipients → 'sent' with error → Problems "Not delivered to everyone"; busy watchdog 20 min.
- Receiving: `fallbackParse` stores unparseable mail with readable headers; a failed ingest keeps last_uid below it;
  expunge only when the server's UID list is complete (≥ EXISTS).
- `accounts.about_me` / `learned_about` (aboutMeJob learns per account too); `userContext(..., account)`; `ctxFor(userId,
  accountId)` for analysis, replies, compose (client sends accountId), thread summaries, events.
- Own categories (ai/custom.js): `custom_categories` (description and/or query, optional account), `message_tags`
  (ai | user | no). Analysis asks for `my_categories` (promptBlock) → `applyAiTags`; `scanCategory` job ('customcat')
  sorts past mail (keyword + semantic candidates, AI batches of 15, user's own choices as examples). View `my~<id>`.
- Also: Back button (web/src/back.js), FollowUp block in the AI card, red Outbox count (`counts.outboxFailed`),
  topics ordered by soonest task/event then recency, collapsible sidebar (localStorage), ModelInput picker,
  requested_items need a verified quote (`checkRequests`).
- Shared mail in My mail (person setting `ui.showShared`): `/api/messages` (date-sorted smart views and search),
  `/api/folders` (accounts tagged `owner`/`ownerName`, smart-view counts summed), tab counts and `/api/accounts`
  include the person's shared spaces. Per-request acting: header `x-halcyon-as` (or `?as=` on GET for images and
  downloads; `asLinks` adds it to cid URLs), membership checked in `actingAs`. Web api.js learns owners from responses
  (message, thread, account, folder, draft, outbox ids) and sends the header; selections across owners are split
  per owner. Events of merged spaces count as own (`setMergedSpaces`).

### Linked event copies, blocked time, context mode, theme (migration 27)
- calendar/linked.js: "Add to my calendar" on events of read-only / info / shared calendars (`POST /api/events/:id/link`,
  in a shared space into the person's calendar; `link-targets`) creates a copy with `linked_cal_id` + `linked_uid`
  (robust to subscriptions recreating rows). `listRange` hides the original where the copy shows. `syncLinked`
  (every 60 s and after updateEvent) copies title/time/place/recurrence from the original; original gone → copy
  'cancelled'. `/unlink` stops following.
- `/api/events` (not allSpaces): `blockedElsewhere` adds anonymous "Blocked · <space>" items (`blocked: true`, no id)
  for busy time in the user's other spaces, and — acting in a shared space — in the person's own calendars.
- `ai.contextMode` ('account' | 'global') + `accounts.context_mode` override; `ctxFor` honours them.
- Rail theme button cycles light → dark → automatic.

### Audit pass + Outlook-style features (migration 28)
- Audit: one noise-category list (`NOISE_LIST` in open-items), `util/text.js` (escapeHtml, textToHtml, keywords) used
  by send/MCP/learning/custom; `openChecker` built once per list (was per row, each reading settings); the costly
  AI part of `/api/folders` (topics, AI categories, own categories) cached 30 s per user+space, keyed by a version
  stamp (newest insight/task/event/tag) and dropped on mail events. Draft attachments → `mail/uploads.js`
  (uploaded once, `{uploadId}` in payloads; cleaned when unreferenced for 2 days). Sync no longer overwrites flags
  that still have a pending 'flags' op. Reader scrolls to the first unread message.
- mail/extras.js: automatic replies (`accounts.auto_reply_json`, `auto_replied`; RFC 3834 headers; never to own,
  list, bulk, automated, auto-replied mail; once per sender per N days), muted threads (`muted_threads`; arriving
  replies archived + read), block sender (a rule "Blocked: <addr>" → spam, + existing Inbox mail), sweep
  (`/api/messages/from-sender`), follow-up (flag + "Follow up:" task with due), quick steps (`quick_steps`; run on
  the client, web/src/mail/extras.js), folder export as mbox (mboxrd). Composer importance (payload.priority).
- AI: `ai_insights.expects_reply` (migration 29) from the analysis of the user's own mail; view `waiting`
  (`waitingSql`: sent, last 30 days, no later message from others in the conversation, not dismissed) with a
  count; reader banner with Nudge (AI follow-up draft) / Stop waiting (dismiss). `meetingPrep` (`POST
  /api/events/:id/prep`, streamed): mail with the participants (90 days) + title keywords, open items, tasks →
  cited briefing; "Prepare with AI" in the event editor.

### Notifications + push (migration 30)
- notifications.js: `notifyUser(ownerId, 'mail'|'reminder', data)` decides per recipient (a shared space → its
  members) by `settings.notifications` (`mail`: all | important | none — older newMail/onlyImportant still read;
  reminders, sound, hideContent, quiet {enabled,start,end} in the user's zone, muteAccounts, muteShared); sends the
  socket event `notify:show` and Web Push (web-push, VAPID keys in app_state 'vapid', `push_subscriptions`;
  404/410 → removed). Triggers: new mail (pipeline), important mail after analysis (same tag → replaces), reminders.
- Web: public/sw.js (push → showNotification; click → postMessage navigate / openWindow), src/push.js
  (enable/disable per device; while push is on the open app does not show its own), Settings → Notifications
  rewritten; PNG icons + manifest (maskable, shortcuts) for installing as an app.

### Android app, touch gestures, desktop window from notifications (no migration)
- (Replaced by the native app, see "Native Android app" below.) Android = Trusted Web Activity built by Bubblewrap: `android/twa-manifest.template.json` + `.github/workflows/android.yml`
  (manual run with host/name/package/version; signing key only from repository secrets, never uploaded). The server
  serves `/.well-known/assetlinks.json` from `HALCYON_ANDROID_PACKAGE` / `HALCYON_ANDROID_SHA256` (config.android),
  so the app opens without a browser bar. Steps for the owner: android/README.md. NOT verified: the workflow itself,
  service-worker registration and push delivery in real Chrome/Android (the dev preview pane refuses service workers).
- Touch: swipe a list row (settings `ui.swipeRight` default read, `ui.swipeLeft` default archive; threshold 90 px)
  and pull the list down to sync; Settings → Mail chooses the swipe actions.
- sw.js, *.html and the manifest are served `no-cache` so installed apps pick up new versions.
- Desktop: clicking a notification brings the window to the front (preload `show` → main `ipcMain.on('show')`).

### Draft on open, recent with the sender, settling items fully (no migration)
- Reader: a conversation whose messages are all read opens at its draft (inline editor, else the quick reply with an
  unfinished text); otherwise first unread, else top.
- Reader: "Recent with <person>" — `GET /api/messages/:id/recent-with` (the sender, or for the user's own mail the first
  recipient; other conversations from/to them in the last year, not Trash/Junk/Drafts, newest first, with summary).
- `POST /api/messages/:id/dismiss` settles every copy of the email (same Message-ID: Inbox + Archive, Gmail All Mail)
  and, with `thread: true`, the conversation's other open items at the same moment (undo restores exactly those, not
  ones the AI closed). The reader settles the message whose insight the AI card shows (was always the newest one, so
  "Not doing it" on an older message's action did nothing); list (threaded) and brief pass `thread`.
- `GET /api/messages/:id` for a shared space's message without acting as it → 404 with `owner` (members only); api.js
  repeats the request as that space. Links to such mail (reload, Recent with, citations) used to say "no longer here".
- List: selected row highlight was hidden by the swipe wrapper's background (now only while swiping).

### Each action settled on its own (migration 31)
- `ai_insights.action_state_json` { "<item text, lower case>": { resolution: done|skipped, at } }, kept across re-analysis
  and copied to duplicate copies (with resolution, resolved_by, needs_reply_user, expects_reply).
- `POST /api/messages/:id/action-item { text, resolution|null }`: settles / reopens one item (all copies and repeats);
  the email is dismissed when every item is settled (all skipped → 'skipped', else 'done') and reopened when one is
  reopened. Whole-email Done makes its items count as settled; reopening one keeps the others; whole-email Undo clears.
- Reader: ActionList in the AI card — every email of the conversation that asks something (reminders repeating a request
  shown once), each item with Done / Not doing it, per email "All done" and "Not an action". Settles that email only.
- `supersededSql` counts only a newer request that is still open (a different request of the same sender and subject
  comes back into view when the newer is settled); true repeats (same sender, same conversation or subject, same action
  or items: `repeatsOf`) are settled and undone together. The brief's Done is per email again.

### Archives, Outlook data files, offline copy in the desktop app, drag attachments out (migration 32)
- `accounts.kind = 'archive'`: mail kept by Halcyon on no server. `queueOp` drops ops for archives and
  `SyncManager.start` never starts them, so everything done to archive mail is local. Archives cannot send (send.js,
  composer hides them, replies to archived mail use a mail account). Settings → Accounts hides them; Settings → Archives.
- mail/archive.js: `addToArchive` (dedupe by Message-ID per folder, ai_status 'none' — imports are not analysed),
  `intoArchive` (copy → read back + sha1 compare → carry over insight / tags / tasks / events → mailbox copy to Trash;
  from another archive: removed there; keep = copy only), jobs (`archive_jobs`, one at a time, progress via
  `archive:job`, resumed after restart; imports are idempotent). moveMessages: into an archive → intoArchive (no undo);
  out of an archive → append, archive keeps it.
- Cross-account moves between mail accounts: the source delete is chained after the append (`then` on the append op)
  — before, a failed append still deleted the original.
- mail/importers.js: PST/OST (pst-extractor 1.12, MIT; folders kept, store root folders dropped, original headers,
  SMTP addresses via PR_SENDER_SMTP_ADDRESS / recipient smtpAddress, attachments incl. embedded messages, read/flag;
  calendar/contacts skipped), MBOX (chunked, mboxrd), EML, ZIP of EML/MBOX (folders from the ZIP paths).
  Verified with the library's sample enron.pst (71 mails, 29 with attachments) and an .ost (`TEST_PST=… npm test`).
- routes/archives.js: list/create, import (octet-stream upload streamed to dataDir/imports, or `{ path }` in the
  desktop's single-user server only), move (ids, or folder + before date), export ZIP of .eml (util/zip.js: stored,
  ZIP64; reader handles deflate). Archives are per owner: shared-space mail only into that space's archives.
  nginx.conf: 50 GB, unbuffered for the import route.
- Desktop server mode keeps a copy on the PC (desktop/offline.js, `protocol.handle` on the server's scheme): GET
  answers cached by URL (+ as / space headers; details without space), emails of lists shown prefetched (2 at a
  time), app shell cached; network error or 502-504 → copy with `x-halcyon-offline`; changes → 503. Logout clears it;
  tray: clear. Opens offline when the server is down at start. Web shows "Offline — copy on this PC". Verified with
  an Electron 44 harness (sign-in through the handler, prefetched message readable offline).
- Attachments drag out: DownloadURL in browsers; desktop fetches to temp on pointerdown and `startDrag` (not tried
  with a real mouse drag yet).
- CalDAV / CardDAV: `syncDav` returns { calendars, books, error } (none found is an error too — tsdav answers a wrong
  address with an empty list); saving an account waits for it (≤30 s) and says the result; failures stay in the
  problems panel (`dav:<accountId>`, "Try again" = `POST /api/accounts/:id/sync?dav=1`). Before, every DAV failure
  was only logged.

### Separate services per account, spaces managed, calendar selection (migration 33)
- `accounts.mail` (1/0): mail is one service of an account, next to calendar (`caldav_url`) and contacts
  (`carddav_url`). mail = 0: never synced (`noMail` in sync.js: no worker, ops dropped), not in /api/folders, not a
  sender (send.js, composer). `serializeAccount().services = { mail, calendar, contacts }`.
- `POST /api/accounts { services: ['mail'|'calendar'|'contacts'…] }` (a calendar / contacts account is named by its
  login and waited for once); `POST /api/accounts/:id/services/:service` adds one (Google: its own addresses);
  `DELETE …/services/:service` removes what Halcyon keeps of it (calendars / books / downloaded mail + memory), never
  anything on the server; the last one removed removes the account.
- OAuth: `?services=` on /api/oauth/:provider/start → scopes only for those (Google `include_granted_scopes`, so adding
  one later keeps the others); the callback adds just those services (existing account: merged).
- Settings → Accounts: service chips (add / change / remove), "Add account" chooser (Mail, Google with checkboxes,
  Calendar, Contacts); the mail editor no longer has DAV fields.
- Spaces: `POST /api/spaces/rename { from, to }` (to '' = remove → shared; to an existing name = merge; facts, memory,
  calendar sources and defaults follow). `settings.defaults[space]` = { accountId, calendarId, bookId } used by the
  composer, the event editor and POST /api/contacts (`spaceDefault`). /api/spaces gives each calendar / book an
  `origin` ("x@y · synced", "host · read-only", "Kept in Halcyon"); address books renamed / default
  (`PATCH /api/address-books/:id`, `address_books.is_default`).
- Calendar: press and drag over empty slots (15-minute steps) → new event for that range (desktop widths).

### Offline-first web app, uploads in pieces, important unread, own certificates (migration 34)
- web/public/sw.js now also caches: app shell (page network-first, /assets cache-first) and API GETs network-first
  with a 4 s wait — no network / no answer in time / 502-504 → the saved copy at once (`x-halcyon-offline`), the
  fresh answer stored and announced (`halcyon:fresh` → app refreshes). Keys include x-halcyon-as / x-halcyon-space.
  /api/auth/status is cached (the app boots from it), sign-in/out, streams, AI answers, uploads are not. Changes
  offline → 503 with a clear message. Logout empties the copy. App: refresh on fresh data, back online, `online`,
  and on return after >30 s hidden (`halcyon:refresh` → folders, list, open conversation `halcyon:reload-open`).
  The "Offline — saved copy" pill reads the state at mount (`offlineState()`). Verified in an Electron harness
  (app opens with the server down, list + folders from the copy).
- Archive uploads in pieces: POST /api/archives/uploads → PUT …/uploads/:id?offset= (409 → continue at size) → import
  { uploadId }. Client starts at 8 MB and halves on 413, resumes after network errors — no proxy setting needed.
- Folder counts: `f.important` (unread with priority ≥ 70, live, not noise) and `counts.unifiedImportant`; the
  sidebar shows them as an accent badge and the rest faded.
- Accounts: `tls_ca` (PEM, added to Node's roots) / `tls_insecure`; used by IMAP, SMTP (tlsOf) and DAV (undici Agent
  via tsdav's `fetch`). Certificate errors explain what to do (certHint, davReason). Settings → Accounts: "Server
  certificate" in the mail editor and the calendar / contacts dialog. HALCYON_TLS_INSECURE=1 still works server-wide.

### Counts, lists that follow changes, Outlook search, problems put aside (migration 35)
- Folder counts: with Focused Inbox on, `f.important` / `counts.unifiedImportant` are the *focused* unread (same rule
  as the Focused tab, `FOCUSED` in routes/mail.js), otherwise priority ≥ 70; `counts.emphasis` says which.
- Mail list (MailView): reloads its first page on `halcyon:mutated` (own changes; again after 2.5 s) and on AI results in
  the AI views; rows are de-duplicated per conversation (`dedupe`). The open message is kept in the list only for the
  read-state tabs, not in Action needed / Needs reply / Waiting / Important / Snoozed, and never next to another
  message of its conversation. A new sort order loads pages until the open message is found and scrolls to it.
- action-item: an email without listed items has its action summary as its one item.
- Search (search.js): Outlook keywords mapped onto the Gmail-style ones — cc:, bcc:, participants:, body:,
  subject:(a b), hasattachments:yes/no, attachments:<name>, isread:, isflagged:, received:/sent: (today, yesterday,
  this/last week|month|year, dates incl. 15.1.2026, >=, <, a..b — `dateRange()`), importance:, folder:; NOT / -word
  (as an FTS NOT IN), OR between words, "from: x" tolerated. Help under the search filters.
- Problems: `problem_dismissals` (user, key, sig = level + error text). POST /api/status/problems/dismiss {keys?} /
  {restore}; GET hides matching ones (`hidden` count, `?all=1`); a dismissal is forgotten once its problem is gone.
  Nothing is retried, dropped or deleted. The panel closes itself when nothing is left (no "all is well" message).
- Starter calendar / address book (bootstrap `dropStarters`): the empty local "Calendar" / "Contacts" are dropped once
  a synced CalDAV / CardDAV one exists (after each DAV sync); its origin reads "Kept in Halcyon only". The default
  calendar can be removed when another writable one takes over. Diagnostics page crash (api.js read its numeric
  `folders` as a list) fixed.

### Tasks: lists in spaces, repeating tasks, CalDAV (VTODO) sync (migration 36)
- `task_lists` (local or `caldav` with account_id + url, readonly, is_default, space like calendars; spaceMap().taskLists,
  scope().taskListIds, space default `taskListId`). `tasks.list_id` (old `list` text kept as a label), `rrule`,
  `due_all_day`, and for sync `uid`, `href`, `etag`, `dirty`, `ics` (the server's VTODO, so other apps' properties are
  kept). Deleted synced tasks wait in `task_deletions`. `ensureTaskLists()` (calendar/todos.js) gives every user a
  default list and puts tasks made elsewhere (follow-ups, MCP, moved in from another user) into it — call it before
  reading tasks.
- API: GET/POST/PATCH/DELETE /api/task-lists (only local lists can be deleted); GET /api/tasks honours the active space
  (no space = all) and `listId`; POST/PATCH take listId, rrule, dueAllDay. Moving a task between lists deletes it from
  the old server collection. New tasks: chosen list → space default → a writable list of the space → default list;
  tasks from an email go to the list of the email account's space.
- Repeating: done on a task with rrule keeps a completed copy and moves the task to the next date (wall clock kept
  over DST, COUNT counts down, last one simply completes) — `completeOccurrence()`; PATCH returns `completedCopy`.
- Sync: syncCalDav also syncs every collection whose components include VTODO (`syncTodoCollection`, not for read-only
  calendar sources): deletions and dirty tasks pushed first (refusals → `task_lists.sync_error` → problems panel), then
  objects fetched with a VTODO comp-filter (tsdav defaults to VEVENT) when the ctag changed or a push is unconfirmed.
  Changes in a synced list trigger syncDav for its account at once. RRULE + DUE written with DTSTART = DUE.
- UI: list chips on the Tasks page (filter, per-device), list menu (rename, default, delete local), list + repeat in
  the add form and editor, "Move to list"; Settings → Spaces: task lists and "New tasks in" per space.

### Writing with the whole relationship in mind; draft check (no migration)
- `ai/context.js` `writingContext(userId, { people, query, threadId, accountId, budget, interactive })`: prompt text
  with WHO THEY ARE (profiles), HISTORY WITH THEM (all conversations with each person, newest first, a
  thread_summaries line or the newest message's analysis; totals since the first email), STILL OPEN (their open
  requests, the user's mail waiting for them, open tasks from their mail, recent / upcoming meetings), RELEVANT
  PASSAGES (memory index hits by meaning, restricted to mail with these people, outside the current conversation),
  FACTS (user facts + nearest learned ones) and, when the text talks about time, busy times + free slots. Everything is
  limited to the space of the account (inIds on account ids, memory owners); budgeted in characters.
- Used by draftReply (also the background prepared draft, non-interactive embedding), composeNew, reviewDraft; the
  assistant adds `historyWith()` for people a question names (`peopleMentioned` in profiles.js), scoped to the chat's space.
- Prompts: "BACKGROUND" block plus rules — do not ask for what was already sent/answered, keep to earlier promises and
  agreements, never invent facts/dates/numbers (use [placeholder]); the user's instruction decides what the reply says.
- POST /api/ai/check-draft { text, subject?, messageId? | to[], accountId? } → { issues: [{ problem, suggestion }] }
  (advice only). Runs after every AI draft (quick reply, composer) and on "Check".
- Quick reply: "Open in the full editor" button always (also empty), an optional hint for the AI (Enter drafts), the
  check result under the text.

### Local default calendar / task list, subscriptions in place, no server-side invitations (no migration)
- Found on a real install: the starter calendar (renamed) and the starter task list stayed the defaults after an
  account's CalDAV calendar was added, so new events / tasks never reached the server. `components/LocalDefault.jsx`
  (Calendar sidebar, Tasks page): when the default is local and a writable synced one exists — make that the default,
  or move everything there: POST /api/calendars/:id/move-events { to } and /api/task-lists/:id/move-tasks { to } (only
  from local ones; same UID already in the target → skipped; marked dirty and pushed). "Keep as it is" hides it per device.
- GET /api/calendars and /api/task-lists return `origin` (spaces.js `originOf`, now exported); the sidebar shows a
  cloud (synced) / drive (Halcyon only) icon.
- Events pushed to CalDAV carry SCHEDULE-AGENT=CLIENT on ORGANIZER / ATTENDEE (`buildIcs(…, { clientScheduling })`):
  Halcyon sends invitations itself; servers with scheduling (Baïkal / sabre iMIP) must not email attendees too.
- Subscriptions refresh in place (`importIcsInto(…, { replace: true })`): unchanged events keep id and updated_at
  (before: every 30 min all events were deleted and re-inserted → re-embedded, reminders / links reset).
- Memory backfill skips items whose job finished in the last 6 h (items with nothing to index were re-queued every
  15 min — ~280k memory jobs a week on a real install).

### Calendars & tasks management (migration 37)
- `hidden` on calendars, task_lists, address_books. A synced one (caldav / carddav) is hidden instead of deleted —
  deleting its row only made it come back with the next sync. Hidden calendars also get enabled = 0 (so listRange,
  free/busy, reminders, calendarForAccount skip them); hidden lists / books are left out of GET /api/tasks and
  /api/contacts. Making one the default shows it again; hiding the default hands the default to another one.
- DELETE on a synced calendar / list / book hides it ({ hidden: true }); on a local one deletes it with its events /
  tasks / contacts (default passed on); a subscription is ended. New: DELETE /api/address-books/:id.
- GET …?all=1 on /api/calendars, /api/task-lists, /api/address-books: every space, hidden ones too, with counts
  (events / total / contacts) and origin.
- Settings → Calendars & tasks (`settings/CalendarsTasks.jsx`): show / hide, rename, default, "Move all to…" (local →
  synced, using move-events / move-tasks, then offers to delete the emptied local one), delete local ones. Linked from
  the Calendar sidebar (gear) and the calendar / task list menus ("Hide calendar", "Hide list", "Manage all …").
- Contacts: POST /api/address-books/:id/move-contacts { to } (local → any writable book). Saved contacts move and are
  uploaded (dirty) unless the target already has the person (same UID or a shared email → skipped); addresses collected
  from mail (auto_collected, not favourite) move along with dirty = 0, i.e. they stay Halcyon-only suggestions and are
  never uploaded. Settings → Calendars & tasks offers "Move all to…" for local books; the Contacts page has the
  LocalDefault notice (kind "addressBook") and a link to the management page.

### Large archive uploads (no migration)
- Client (settings/Archives.jsx `send`): each piece has a 2-minute limit (AbortSignal.timeout); a stalled or dropped
  piece is retried after a back-off with half the size (≥ 1 MB), 413 halves too; up to 25 failures in a row. Progress
  shows bytes, percent with a decimal, speed and time left, and what is happening (retry, smaller pieces); Cancel.
  The upload id is kept in localStorage per archive + file (name, size, lastModified): choosing the same file again
  continues at the server's size (GET /api/archives/uploads/:id → { size, total }); a page close is warned about.
- Checked on a real install: 8 MB pieces pass its proxy; pst-extractor reads by file descriptor (fine for 4 GB+).
- A file that is not a PST/OST fails with a readable reason; job errors are stripped of control characters.
- Outlook data files are read in a worker thread (`mail/pst-worker.js` → `mail/pst.js` `readPst`; importers.js
  `pstImport` stores each email in the main thread and then asks for the next one). pst-extractor reads synchronously:
  in the main thread a 4 GB file blocked the whole server for minutes (open + folder count); measured on the 14 MB
  sample: worst main-thread stall 2.4 s before, 1 ms now. round38's PST test (TEST_PST) asserts the server stays
  responsive.

### Analysis by hand, space targets, automatic retries (migration 38)
- POST /api/ai/reprocess takes `folderId` / `accountId` (one folder, mailbox or archive — any folder but Trash/Junk,
  whatever ai.analyzeFolders says) and `count: true` (dry run). Mail older than ai.openItemsDays is queued with
  { quiet: true } unless `quiet` is given. UI: folder menu "Analyse older mail with AI…" and the archive card
  (`components/AnalyzeOld.jsx`).
- `targets.js` `targetsForMessage()` → { space, calendarId, taskListId, bookId } of the email's account's space
  (space defaults first). GET /api/messages/:id/targets (events from an email open in that calendar);
  POST /api/messages/:id/save-sender (saves the sender into that book; a collected address becomes a saved contact,
  no duplicate). `addressBookForAccount` now prefers the account's book, the default, then synced books; never hidden.
- `mail/retry.js` `autoRetry()` (scheduler, every 5 min): failed pending_ops (attempts ≥ 5) get one more try after
  15 min, 30 min, 1 h … 24 h (8 times; pending_ops.auto_retries / next_retry_at); outbox rows that failed before
  reaching the server (UNREACHED errors) are queued again up to 6 times (other failures may have been delivered and
  stay manual); unsaved sent copies are queued again; an SMTP "sending failed" warning is re-checked every 10 min and
  cleared when the server answers. The problems panel shows these as warnings with the next try until they succeed.
- AI card on phones: suggested-event and reply buttons never wider than the card (title shortened / replies wrap).

### Calmer interface, command palette, pinned conversations, notes (migration 39)
- Sidebar (MailView `FolderNav`): core views (All inboxes, Needs reply, Action needed, Flagged, Snoozed, Outbox &
  drafts); Important and Waiting for reply under "More" (shown while open; also "New category" / "New label" when
  none exist — their sections are hidden while empty). No "New folder" rows: account header menu (right-click or "…"):
  New folder, Analyse older mail, settings. AI categories and archives start folded (stored per device).
- List rows: line 1 sender + state icons (reply needed, action, draft, note, invitation, attachment, flag) + date;
  line 2 subject — preview (AI summary when shown); a third line only for topic / categories / labels / phishing /
  shared space / not on server.
- Pinned conversations: `pinned_threads` (user, thread_key = thread id or "m:<id>"); GET/POST
  /api/messages/:id/pin (by message, so shared-space mail is pinned in its space); list `pinned` / `hasNote` flags,
  `?pinned=1|0`; in inbox views (newest first, no search) a "Pinned" group above the list.
- Notes: `thread_notes`; GET/PUT /api/messages/:id/note; reader shows a note box (autosaved), header chips Pin /
  Note / Unsubscribe (when List-Unsubscribe).
- Reader AI card: category, priority, important / not important and "mark as needs reply" in one "⋯" menu; the
  contact profile moved into "Recent with", which is a one-line toggle.
- Command palette (`components/CommandPalette.jsx`): Ctrl/⌘+K or the ⌘ button in the rail — actions, views, folders,
  spaces, settings, mail and people found for the text, "Search mail for …", "Ask the assistant …" (via
  sessionStorage halcyon.ask). Events: `halcyon:palette`, `halcyon:search` (MailView), `halcyon:new-event` (Calendar).

### Native Android app with Firebase Cloud Messaging (migration 40)
- Why: the Trusted Web Activity depended on Chrome's Web Push staying alive (notifications often missing on a real
  phone), and its launcher shortcuts reopened the last page instead of the chosen one (Chrome reused the tab).
- `android/`: Kotlin app (minSdk 24, target/compile 36, AGP 8.9.1, Kotlin 2.1, Gradle 8.11.1, no AppCompat), package
  `cc.halcyon.mail` signed with the same key as the TWA, so it installs as an update. MainActivity = the server in a
  WebView (singleTask; cookies flushed on pause; back = web history, then to background; window.open / target=_blank
  caught by a throwaway WebView; same-origin `/api/` links and downloads fetched natively with the session cookie →
  Downloads (MediaStore) or, for `?inline=1`, cache + ACTION_VIEW via FileProvider; blob: read by the page and passed
  as base64; mailto: → `#/compose?url=…`; other links open outside). ConnectActivity: server address checked with
  `/api/health` before saving; CA certificates added in the app (Trust.kt, filesDir/ca) are accepted in
  `onReceivedSslError` only for the configured host, only when the issuer is the sole problem; network_security_config
  trusts user-installed CAs too. Dynamic shortcuts (Shortcuts in MainActivity.kt): New message, Mail, Calendar,
  Tasks, Contacts → `ACTION_OPEN` + `route` extra; `onNewIntent` moves a running page with `window.halcyonOpen(route,
  as)` (push.js, also enters the shared space of a notification), a page that is not ready is loaded at
  `<server>/#/route`. Routes must start with `#/` (the activity is exported).
- Push: PushService (FirebaseMessagingService) draws data messages itself (channels mail / mail_quiet / reminders;
  tag = notification tag so updates replace; tap → MainActivity with route + as); onNewToken only stores the token,
  the web app registers it again on each start. Bridge `window.halcyonAndroid` (addJavascriptInterface; methods
  refuse unless the page origin is the server): `pushState()`, `call(id,'enable')` → POST_NOTIFICATIONS (13+) + FCM
  token, answered by `window.halcyonAndroidResolve(id, result)`; `setOn`, `ready`, `saveFile`, `retry`, `changeServer`.
- Server: `fcm.js` (HTTP v1, service-account JWT → OAuth token cached ~1 h, 401 → new token; 404 / UNREGISTERED /
  invalid token → `{ gone }` → row deleted); `fcm_tokens` (migration 40, token UNIQUE, moves to the user who registers
  it last); notifications.js `pushFcm` next to Web Push with the same message (+ `kind`, `as` as strings; hideContent
  already applied) and the same decision of what notifies. Routes: `GET /api/push/fcm` (available, error),
  `POST /api/push/fcm/register|unregister`; `/api/push/devices` lists Android devices too (kind 'android').
  Config: `HALCYON_FCM_SERVICE_ACCOUNT` (path; `HALCYON_FCM_URL` only for tests). round48 tests registration, the
  message shape (data only, priority HIGH, hidden content), token reuse of the access token and forgetting dead tokens
  against a local mock of Google's token + FCM endpoints.
- Web: push.js uses the bridge when present (Settings → Notifications shows why push is unavailable: no Firebase in
  the build / server not configured); the service worker is still registered there (offline cache).
- Build: `android/build-local.sh` (JDK + SDK in ~/android-build, Gradle downloaded there; builds in a copy;
  `google-services.json` from android/app or GOOGLE_SERVICES_JSON, package checked; versionCode = minutes − 29e6 like
  the TWA); `.github/workflows/android.yml` (secrets incl. GOOGLE_SERVICES_JSON_BASE64). Owner steps (Firebase project,
  service-account key): android/README.md. The assetlinks.json route / HALCYON_ANDROID_* stay for old TWA installs.
- Verified: the release APK builds and is signed with the TWA's key (with a placeholder google-services.json); server
  tests. NOT verified: running on a phone or emulator (no KVM access in the dev WSL) — WebView loading, the private-CA
  path, shortcuts/onNewIntent, file chooser, downloads, and real FCM delivery need a check on the owner's phone.

### List rows, task wrapping, Flagged folder, repeating tasks from mail (no migration)
- Message list: subject on its own line again, the AI summary (up to two lines, ✦) or the text's beginning below it;
  the sender 600 (unread 700). Hovering a row shows a tooltip (`rowDetails` in MailView.jsx): from/to with addresses,
  full date, subject, the whole summary and the to-do.
- Reader: tasks / events made from an email wrap inside the AI card (`.follow-up` was a grid whose track grew to the
  single-line text and widened the reading pane).
- A server's virtual `\Flagged` folder is never synced (sync.js sets sync_enabled = 0), so it stayed empty or stale:
  opening it (view=folder) now lists that account's flagged mail from Halcyon's own flags (routes/mail.js scopeFor).
- "Add to tasks" from an email has the Repeat choice (needs a due date); POST /api/tasks/from-message takes `rrule`.
- Migration safety: the Android branch first shipped its FCM table as migration 38; after merging, 38 is automatic
  retries and FCM is 40 (`CREATE TABLE IF NOT EXISTS`). db/index.js adds 38's columns when they are missing, so a
  database that ran the branch before the merge starts normally (round50). round49: Flagged folder, repeating tasks.

### Phone fixes, quick retries, Flagged view (no migration)
- Flagged view (all accounts) showed nothing: MailView `viewQuery` read every view starting with "f" as folder
  `f<id>` ("flagged" → folder "lagged"); now only `f\d+` / `l\d+`.
- Phone: the folder drawer has a backdrop (tap beside it closes it), Escape closes it, and the Android app's back
  button asks `window.halcyonBack()` first (MailView sets it while the drawer is open).
- Settings cards (`.item-card`) and section headings wrap below 600 px: the buttons go under the text (they squeezed
  account status into a column a few words wide).
- sw.js: `navigator.onLine` is not trusted (Android's WebView may say offline while online — every answer then came
  from the copy and the app always said "Offline — saved copy"); a copy that stands in for a slow answer is marked
  `x-halcyon-stale` (no offline banner), only a failed request or 502-504 marks `x-halcyon-offline`.
- Retries start fast: mail/retry.js RETRY_STEPS 30 s, 1, 2, 5, 10, 20, 30 min, 1 … 24 h (autoRetry every 20 s;
  sends 10 retries); a failed send is tried again after 10 s, 30 s, 1 min, 2 min. DAV sync (scheduler.js) that fails
  for a passing reason (502-504, connection) is tried again after 5 s, 15 s, 30 s, 1, 2, 5 min before the 10-minute
  cycle; background syncs stay out of the problems panel for the first DAV_QUIET (3) tries, then show as a warning
  with the next try's time. Syncs the user waits for (`syncDav(a, { asked: true })`: saving, "Try again") report at once.

### Reliable Android push, resizable columns, scheduling help, Senders cleanup, contact tidying (migration 41)
- FCM messages now carry a `notification` part (+ android.notification: channel, tag, icon, color) next to the data:
  in the background Google Play services shows it itself (no need to wake the app — battery savers on many phones
  refused that, so data-only messages went missing); in the foreground the app draws it from the data. Data carries
  `route` (= url), the extra MainActivity reads when the system's notification is tapped. Registering the app deletes
  the user's Web Push subscriptions named "Android" (Chrome / the old TWA notified twice and Chrome flagged the site
  as spamming). Settings → Notifications lists devices with a × each (DELETE /api/push/devices/:kind/:id).
- Mail columns: drag the borders (MailView `ColResizer`; widths in localStorage `halcyon.mailColumns`, CSS variables
  --sidebar-w / --list-w above 860 px); double-click resets.
- Touch screens never show the row hover buttons (`@media (hover: none)`); Tasks: a click on the text shows the
  details (or opens a task without any).
- Arranging a meeting (Reader `Scheduling`, in the AI card's follow-up when the email proposes times or talks about
  meeting): proposed times checked against the calendar (POST /api/calendar/check → free / clashes with), and the
  next free slots (existing /api/calendar/free-slots; 15 min–2 h) chosen and sent in a reply (AI writes it in the
  conversation's language when enabled).
- Mail → More → Senders (routes/senders.js, mail/Senders.jsx): senders by volume with read rate, inbox count,
  unsubscribe (existing endpoint), archive all from the inbox, mark all read.
- Contacts → Tidy up (contacts/review.js, contacts/Review.jsx, `contact_suggestions`): merge suggestions (same address,
  same name with accents/order ignored, AI-confirmed name variants at the same non-public domain or same local part)
  and save suggestions (collected contacts written to ≥ 3 times, correspondents with an AI profile and ≥ 5 emails, with
  the profile's organisation); accept (merge into the chosen contact) / reject (never again) / all; scanned daily.
- Accent-insensitive: `fold()` SQL function also in event search and the assistant's contact tool.

### Learned from habit; Latin/Cyrillic contacts (round52)
- `ai/habits.js`: a sender whose last ≤ 10 emails of 90 days (≥ 1 day old) number ≥ 5, with ≤ 1 in 10 read and none
  answered, is "rarely read" — analysis holds it at priority ≤ 20, no needs-reply, no suggested replies, and new mail
  from it does not notify (pipeline). Never for addresses in the contacts or the user's own addresses, never against an
  explicit important/unimportant correction; switches off when the user reads them again. Per-sender opt-out in
  `sender_habits` (migration 42) via POST /api/senders/habit {address, keep}; Senders shows "Learned" / "Treated normally".
  Cached per user for 10 min (`forgetHabits`).
- Contact review: names compared by `sounds()` (Cyrillic transliterated; č/ч, š/ш, ž/ж, г/h/g, й/и/y/j/i, doubled
  letters unified), so "Ігор Васківський" = "Ihor Vaskivskyi"; reason "Same name in Latin and Cyrillic". AI variant
  pairs also include contacts in different scripts sharing a surname (contacts without email but with phones too).

### Inkwell notes next to mail, events and tasks (migration 43, round53)
- Inkwell (the user's self-hosted notes app, its own repo) links its pages to Halcyon items through the MCP endpoint
  (refs = Halcyon's numeric ids as strings; kinds `email`, `event`, `task`). This is the reverse direction.
- `integrations` table (user_id, kind = 'inkwell', base_url, token_enc): Settings → Integrations stores the address and
  an Inkwell API token (`ink_…`, made in Inkwell → Settings → Apps & tokens), encrypted, never returned
  (GET/PUT /api/integrations/inkwell → { url, hasToken, configured }; PUT { url: '' } disconnects; POST …/test).
  `/api/integrations` always acts as the person (PERSON_ONLY), so a person's own Inkwell also serves shared spaces.
- GET /api/integrations/inkwell/links?kind=…&ref=1,2,… (integrations.js `inkwellLookup`): one request to Inkwell's
  /api/links/lookup for up to 100 numeric refs, 4 s timeout; only refs asked for are passed on; a relative or
  non-http(s) `url` (Inkwell without INKWELL_PUBLIC_URL) becomes `<base>/#/n/<id>`. Not set up, unreachable or token
  refused → { url: null, links: [] [, error] } and the views render exactly as without Inkwell.
- Web `components/InkwellNotes.jsx` (answers cached 1 min per page load): the reader (all messages of the
  conversation), the event editor (id + seriesId) and the task editor show "Notes" with the linked pages and
  "New note in Inkwell" (opens `<base>/#/`).
- Inkwell behind a private CA (migration 44: `integrations.tls_ca` / `tls_insecure`): its CA as PEM (pasted or loaded
  from a .pem/.crt/.cer file — DER is turned into PEM in the browser; the same "Load from file…" now also serves the
  accounts' Server certificate) or no check; requests then go through an undici Agent built from `tlsOf()`.
  Certificate errors say what to do (`inkwellError`). Tests use `server/test/fixtures/tls` (test CA + server
  certificate for 127.0.0.1, valid for 100 years; the CA key is not kept).
- "New note in Inkwell" (or "Open in Inkwell" when notes are linked) opens `<inkwell>/#/new?kind=&ref=&title=…` in the
  same tab (event: start, end, location, attendees; email: from, date; task: due — `server/src/util/inkwell.js`
  `inkwellNewUrl`, shared with the web UI): Inkwell opens the linked note or makes one. The rail has "Notes" (opens
  Inkwell) while it is connected (`store.inkwell`, data.js `loadInkwell`).

### All-day events are dates; multi-day selection (migration 45)
- All-day events are stored as UTC midnight of their date (`allDayMs`, calendar/recurrence.js): createEvent / updateEvent
  round to it, `dateOnly` in ics.js too, migration 45 converts rows that held a local midnight (their rules fell on the
  wrong day and their end reached into the next). CalendarView turns them into local midnights on load (`localAllDay`).
- `expand()` runs rules on wall-clock time in the event's zone (the user's when the zone name is unknown, e.g. Windows
  names from Outlook), so BYMONTHDAY / BYDAY mean the event's own day and the time stays across DST.
- Not recoverable automatically: an all-day event made in the editor and already saved to a CalDAV server before this
  fix was written one day early there, and came back so.
- `useDaySpan` (CalendarView): press and drag over days in month view or the all-day row of week / day view opens a new
  all-day event over them. Mouse only, like the time selection.
- DAV rate limits (scheduler.js): 429 / RESOURCE_EXHAUSTED pauses that service of the account for 15 min … 6 h
  (`davHold`, per account + cal/card; shown as a warning with the next try, a sync the user asks for still runs). Google
  is asked at most every 30 minutes unless something waits to be saved (`davLast`).
- Summaries follow what is settled (migration 46, round56): done / not doing / "no reply needed" and reopening call
  `refreshSettled`, which queues job `settled` (rewrites `ai_insights.summary`; the AI's first text stays in
  `summary_base`, restored when nothing is settled) and a forced `thread` job (prompt gets a SETTLED list). Re-analysis
  queues `settled` again. Needs an AI provider; the summary stays as it was while none answers.
- Removing "needs reply" also clears copies and older repeats (same sender and subject, which `supersededSql` only hid);
  the reader always clears the whole conversation.
- Action needed agrees with the AI card: action items without `needs_action` go to the second opinion like any action
  and are dropped if it rejects them; only newsletter / promotion / social are left out, no priority limit ("Not
  important" clears the action). `reanalyzeItems` re-checks recent mail once. Only Inbox mail is listed.
- Reader: "Files" chip lists a conversation's files (`threadFiles`). Search: Results / AI tabs. Assistant: sources folded.
- Spaces and Inkwell: MCP `list_spaces` ({ spaces }; a token with its own space: only that one). search_mail,
  list_open_items, list_events and list_tasks take an optional `space` (a token's own space always wins) and return
  each item's effective `space` ('' = shared). list_tasks now honours a token's space too; list_events returns nothing
  for a space without calendars (listRange reads an empty list as "all"). `#/new` carries `hspace`, and for events the
  occurrence's own start (ref stays seriesId || id): Inkwell keeps one note per occurrence and its lookup rows carry
  `date`, so "Open in Inkwell" shows for an event only when a note has this occurrence's date (`sameOccurrence`).
- Event deep links also carry `day` (YYYY-MM-DD, `occurrenceDay`: the browser's zone, the UTC day for all-day events).
  Inkwell uses it for the note's title, same-day matching and the `date` of its lookup rows, so both sides agree.
- To-do sync with Inkwell: MCP propose tool `complete_task` { id, done = true } (routes/tasks.js `setTaskDone`: same effect
  as the tick, with repeating tasks and CalDAV push; space and read-only lists respected). The answer is the task's real
  state: a repeating task stays open on its next date (`done: false`, `next_due`, `completed_id`). `list_tasks` takes
  `ids` (at most 200): exactly those tasks, done or not, past the 100 limit of the plain list.
  Each task from `list_tasks` also says `repeats`: Inkwell reads a moved due date of a repeating task as ticked.

# Architecture

```
┌────────────── clients ──────────────┐        ┌──────────────────── Halcyon server (Node.js) ─────────────────────┐
│ Browser SPA (React)                 │  REST  │ Fastify API ── auth (sessions / desktop token)                     │
│ Electron desktop (Windows/Linux/mac)│◄──────►│   │                                                                │
│   ├─ local mode: forks the server   │  WS    │   ├─ Sync manager ─ one worker per account (ImapFlow, IDLE)        │──► IMAP
│   └─ remote mode: loads server URL  │ events │   │     └─ pending ops queue (offline-first actions)               │
└─────────────────────────────────────┘        │   ├─ Outbox (undo/scheduled send, nodemailer) ─────────────────────│──► SMTP
                                               │   ├─ CalDAV / CardDAV sync (tsdav), ICS subscriptions ────────────│──► DAV
                                               │   ├─ Ingest pipeline: parse → thread → FTS → contacts → rules → AI │
                                               │   ├─ AI job queue (SQLite) → handlers → provider router ───────────│──► Ollama / OpenAI /
                                               │   │     analyze · thread · embed · draft · brief                   │    Anthropic / Gemini / …
                                               │   ├─ Scheduler: reminders, snooze wake-up, brief, DAV refresh      │
                                               │   └─ SQLite (WAL, FTS5) + raw .eml store                           │
                                               └────────────────────────────────────────────────────────────────────┘
```

## Server
- **Storage** — one SQLite database (`better-sqlite3`, WAL) holds users, accounts, folders, messages, AI insights,
  embeddings, calendars, events, contacts, tasks, jobs. Raw RFC 822 sources are stored content-addressed on disk
  (`data/mail/<account>/<sha1>.eml`) for attachments, forwarding and re-parsing.
- **Sync** (`server/src/mail/sync.js`) — per-account long-lived IMAP connection. Full cycles list folders, download
  new UIDs (newest first; initial window configurable), reconcile flags (CONDSTORE `CHANGEDSINCE` when available),
  detect expunges and UIDVALIDITY resets. INBOX stays selected so the server pushes `EXISTS` via IDLE. User actions
  are written locally first and queued in `pending_ops`, replayed in order with retries. Moves use UIDPLUS `COPYUID`
  maps to keep message identity (and its AI insight) stable; otherwise the moved copy is matched by Message-ID.
- **Ingest pipeline** — mailparser → threading (References/In-Reply-To) → FTS5 index → contact collection → rules
  → AI jobs → WebSocket notification.
- **AI** — `ai/providers/*` adapt each vendor's API (chat, streaming, JSON mode, embeddings, model listing) behind one
  interface. `ai/router.js` resolves the provider/model per task (background, compose, chat, embeddings) and applies
  privacy mode. `ai/queue.js` is a durable priority queue with dedupe, per-user concurrency, exponential back-off and a
  *waiting* state for jobs without a configured provider. `ai/tasks.js` implements the handlers; results are stored
  and pushed to clients so the UI updates live.
- **AI memory** (`ai/memory.js`, table `memory`) — what search and the assistant retrieve from: emails split into
  overlapping ~1.4k-character passages (each repeating the email header), conversation summaries, events, contacts
  (saved/favourite ones) and short facts (table `facts`: learned during analysis — de-duplicated semantically — or told
  to the assistant with "remember that …"). Vectors are stored in SQLite as float32; on first use per user they are
  loaded into one int8-quantised array (~1 KB per passage at 768 dims) that is dropped after 30 min idle, so a
  multi-user server keeps only active users in RAM. Every row has an owner key (`a:<account>`, `c:<calendar>`,
  `b:<address book>`, `s:<space>`) used for scoping. Indexing runs through the job queue (`embed` for mail, `memory`
  for the rest, batched); `backfillMemory()` re-indexes anything missing or indexed with another embedding model, and
  an hourly purge removes memory of deleted items (deleting mail or an account removes its memory immediately).
- **Spaces** (`spaces.js`) — labels such as "Work"/"Private" on accounts, calendars and address books ('' = shared;
  calendars/books without their own label inherit their account's). The client sends the active space in the
  `x-halcyon-space` header; `scope(userId, space)` turns it into allowed account/calendar/address-book ids and memory
  owner keys, applied to mail lists, folder counts, search, calendar, contacts, autocomplete, the daily brief (one per
  space) and the assistant. A chat is bound to the space it was started in. Free/busy uses all calendars (one person,
  one schedule) but only exposes free slots.
- **Search** — Gmail-style operator parser compiled to SQL, FTS5 with bm25 + recency ranking, and embedding search,
  combined with reciprocal-rank fusion.
- **Calendar** — events stored in UTC with optional TZID; recurrence expanded with `rrule` and corrected for DST in
  the event's zone; exceptions stored as rows with `recurrence_id`; iMIP for invitations; CalDAV objects pushed as
  whole VCALENDARs per UID.

## Security
- Passwords: scrypt. Sessions: random 256-bit tokens in HTTP-only SameSite=Lax cookies; login throttling.
- Stored secrets (IMAP/SMTP/DAV passwords, OAuth tokens, AI keys): AES-256-GCM with a master key from
  `HALCYON_SECRET` or a generated key file.
- Email HTML: sanitised server-side (no scripts, handlers, forms, iframes), rendered in a sandboxed iframe without
  script permission; remote content blocked by default; attachments served with `nosniff` and a restrictive CSP.
- Desktop: server bound to loopback and gated by a per-launch secret cookie; renderer sandboxed with context
  isolation and a minimal preload bridge.

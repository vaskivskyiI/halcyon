# Features

Halcyon's feature set was planned against the leading clients — Microsoft Outlook (new Outlook / classic),
Gmail (with Gemini), Spark, Superhuman and Thunderbird — with the goal of covering what people rely on daily
and going further on AI, privacy and self-hosting.

## Mail
- Unlimited IMAP/SMTP accounts; unified inbox plus per-account folders; account colours
- Setup autodiscovery: built-in presets (Gmail, Outlook.com/M365, iCloud, Yahoo, Fastmail, GMX, Web.de, Zoho, AOL, Proton Bridge, …), Mozilla ISPDB / domain autoconfig, MX detection; connection test before saving
- OAuth2 (XOAUTH2) sign-in for Google and Microsoft; app-password support
- Real-time push via IMAP IDLE; CONDSTORE-based flag sync; UIDPLUS-aware moves; expunge detection; UIDVALIDITY recovery
- Offline-first: actions apply instantly and are replayed to the server, with retries
- Conversation (thread) view based on Message-ID/References, de-duplicating Sent copies; can be switched off
- Focused / Other inbox driven by AI priority and category; smart folders: Important, Needs reply, Flagged, Snoozed, Outbox & drafts
- Read/unread, flag, archive, delete, spam/not-spam, move (incl. between accounts), labels, snooze with presets
- Drag & drop to folders; multi-select (Ctrl/Shift-click); context menus; hover actions
- Keyboard shortcuts (j/k, r, a, f, e, #, !, s, u, x, /, c, Esc, Ctrl+Enter)
- Folder management: create, nested folders, rename, delete, empty Trash/Spam, mark all read, per-folder sync toggle
- Search: Gmail-style operators (`from: to: subject: has:attachment is:unread in: before: after: newer_than: label: category: account:` and negation), SQLite FTS5 full text with diacritics folding, and **semantic search** (embeddings) fused with reciprocal-rank fusion
- Rich composer: formatting, lists, quotes, links, inline images, attachments (drag/paste), Cc/Bcc, multiple identities/aliases, per-account HTML signatures, templates
- Recipient autocomplete ranked by frequency/recency; auto-collected contacts
- Undo send (configurable window), schedule send (presets or exact time), outbox with retry, autosaved drafts (and saving drafts to the IMAP Drafts folder)
- Forgotten-attachment check; empty-subject warning
- Correct reply threading headers; reply-all de-duplication; forward with original attachments
- Safe rendering: server-side HTML sanitising + sandboxed iframe (no scripts), remote images and CSS tracking blocked unless the sender is a contact, per-message "show images"
- One-click unsubscribe (RFC 8058) with mailto/URL fallbacks
- Print, download .eml, attachments preview/download, inline (cid:) images
- Rules/filters: sender/recipient/subject/body/attachment conditions **and AI conditions** (category, priority, needs reply); move, archive, mark read, flag, label, delete, spam, forward; "run now" on existing mail
- Desktop notifications (all mail, or only AI-important mail)

## Calendar
- Day, work week, week, month and agenda views; mini-month navigator
- Drag to move and resize events (15-minute snapping), overlap layout, all-day row, current-time line, working hours shading
- Recurring events (daily/weekdays/weekly/biweekly/monthly/yearly, count/until), edit or delete *this occurrence* vs *the series*, DST-correct expansion
- Reminders (toast + desktop notification), busy/free, multiple calendars with colours and visibility toggles
- Invitations: send iMIP REQUEST/CANCEL to attendees; incoming invitations show an RSVP card (Accept / Maybe / Decline) that updates your calendar and replies to the organizer; incoming REPLY/CANCEL update events automatically
- Online-meeting links (Teams/Zoom/Meet/Webex detected; one-click Jitsi link creation) with "Join" buttons
- Free-slot finder within working hours
- CalDAV two-way sync (Nextcloud, iCloud, Fastmail, Google, Radicale, SOGo, …), ICS import/export, read-only ICS/webcal subscriptions (holidays, shared calendars)

## Contacts
- Contacts with multiple emails/phones/addresses, company, title, birthday, website, notes, photo, groups, favourites
- Auto-collected correspondents (separate from saved contacts); merge duplicates
- Contact page shows recent emails and meetings with that person
- CardDAV two-way sync; vCard import/export; CSV import (Outlook & Google exports)

## Tasks
- Tasks with due dates, importance, completion; overdue/today/upcoming grouping; due reminders
- One-click creation from AI-extracted action items, linked back to the source email

## AI (all optional, provider-agnostic)
- **Background pipeline** — processed as mail arrives, newest first, so results are ready when you open a message:
  - summary, category, priority score with reason, needs-reply detection, sentiment, language, phishing suspicion
  - action items (→ tasks) and dates/meetings (→ calendar events)
  - three smart-reply suggestions; **full reply drafts pre-written** for important mail awaiting your answer
  - conversation summaries for longer threads
  - embeddings for semantic search
  - **daily brief** generated before your day starts (important mail, awaiting replies, schedule, tasks)
- **On demand** (streamed token by token): write a new email from a description, draft a reply with an intent ("accept, propose Thursday"), rewrite (improve, fix grammar, shorter, longer, formal, friendly, confident, bullets), translate a message or your draft, extract an event from any email
- **Assistant chat** over your mail, calendar, contacts and tasks with retrieval (hybrid keyword + semantic) and clickable citations; finds free time
- **AI memory**: long emails are indexed passage by passage, plus conversation summaries, events, contacts and durable facts (learned from mail or told with "remember that …"); reviewable and deletable in Settings → AI → Memory
- **Spaces** (e.g. Work / Private): accounts, calendars and address books are assigned to a space; mail, search, calendar, contacts, the daily brief and the assistant can work on one space or on everything
- Personalisation: "about me" context (improves prioritisation), writing style, reply language; VIP contacts boost priority
- Providers: Ollama, OpenAI, Anthropic, Google Gemini, OpenAI-compatible (LM Studio, vLLM, llama.cpp, LocalAI, Groq, Mistral, OpenRouter, DeepSeek); per-task routing; model listing; connection test; Ollama model pull
- Privacy mode (local/LAN providers only); per-model usage, token and latency statistics; re-analyse / rebuild index

## Platform
- Web (responsive, mobile layout, PWA manifest), Windows desktop installer, Linux/macOS desktop builds
- Ubuntu server deployment (systemd hardening, nginx + Let's Encrypt), Docker Compose with Ollama
- Multi-user with admin user management; scrypt password hashing; login throttling; HTTP-only SameSite cookies
- Credentials and API keys encrypted at rest (AES-256-GCM)
- Light/dark/system theme, comfortable/compact density
- Real-time UI updates over WebSocket

## Comparison

| Capability | Outlook | Gmail | Spark | Thunderbird | **Halcyon** |
|---|:-:|:-:|:-:|:-:|:-:|
| Any IMAP/SMTP account, unified inbox | ✓ | partial | ✓ | ✓ | ✓ |
| CalDAV / CardDAV | – | – | – | ✓ | ✓ |
| Self-hostable server | – | – | – | n/a | ✓ |
| Web + Windows desktop from one install | ✓ | web only | ✓ | desktop only | ✓ |
| Focused inbox | ✓ | tabs | smart inbox | – | ✓ (AI) |
| Snooze / schedule send / undo send | ✓ | ✓ | ✓ | add-ons | ✓ |
| Rules with AI conditions | – | – | – | – | ✓ |
| AI summaries & smart replies | Copilot (paid) | Gemini (paid) | ✓ (paid) | – | ✓ |
| Reply drafts pre-written in background | – | – | – | – | ✓ |
| Daily AI brief | partial | – | – | – | ✓ |
| Chat with your mailbox + calendar | Copilot (paid) | Gemini (paid) | ✓ | – | ✓ |
| Semantic search | Copilot | ✓ | – | – | ✓ |
| Choose your AI provider / run AI locally | – | – | – | – | ✓ |
| Calendar invitations (iMIP RSVP) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Tasks from email | ✓ | ✓ | – | ✓ | ✓ (AI-extracted) |

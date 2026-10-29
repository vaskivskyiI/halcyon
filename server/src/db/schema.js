// Versioned migrations. Each entry runs once, in order.
export const migrations = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, password_hash TEXT,
    is_admin INTEGER DEFAULT 0, settings_json TEXT DEFAULT '{}', created_at INTEGER
  );
  CREATE TABLE sessions (
    token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER, expires_at INTEGER, user_agent TEXT
  );
  CREATE TABLE accounts (
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT, email TEXT NOT NULL, display_name TEXT,
    imap_host TEXT, imap_port INTEGER, imap_secure INTEGER, imap_user TEXT, imap_pass_enc TEXT,
    smtp_host TEXT, smtp_port INTEGER, smtp_secure INTEGER, smtp_user TEXT, smtp_pass_enc TEXT,
    auth_type TEXT DEFAULT 'password', oauth_enc TEXT,
    signature_html TEXT DEFAULT '', color TEXT, sync_enabled INTEGER DEFAULT 1,
    sync_state TEXT DEFAULT 'idle', sync_error TEXT, last_sync_at INTEGER,
    caldav_url TEXT, carddav_url TEXT, dav_user TEXT, dav_pass_enc TEXT,
    aliases_json TEXT DEFAULT '[]', sort_order INTEGER DEFAULT 0, created_at INTEGER
  );
  CREATE TABLE folders (
    id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    path TEXT NOT NULL, name TEXT, delimiter TEXT, special_use TEXT, parent_path TEXT,
    uidvalidity TEXT, last_uid INTEGER DEFAULT 0, highest_modseq TEXT,
    total INTEGER DEFAULT 0, unread INTEGER DEFAULT 0, subscribed INTEGER DEFAULT 1,
    sync_enabled INTEGER DEFAULT 1, last_synced_at INTEGER,
    UNIQUE(account_id, path)
  );
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE, uid INTEGER,
    message_id TEXT, in_reply_to TEXT, references_json TEXT, thread_id TEXT,
    subject TEXT, from_name TEXT, from_addr TEXT, to_json TEXT, cc_json TEXT, bcc_json TEXT, reply_to_json TEXT,
    date INTEGER, snippet TEXT, body_text TEXT, body_html TEXT,
    has_attachments INTEGER DEFAULT 0, attachments_json TEXT DEFAULT '[]', size INTEGER,
    is_read INTEGER DEFAULT 0, is_flagged INTEGER DEFAULT 0, is_answered INTEGER DEFAULT 0, is_draft INTEGER DEFAULT 0,
    snoozed_until INTEGER, labels_json TEXT DEFAULT '[]', raw_path TEXT,
    list_unsubscribe TEXT, calendar_ics TEXT, ai_status TEXT DEFAULT 'pending', created_at INTEGER,
    UNIQUE(folder_id, uid)
  );
  CREATE INDEX idx_messages_folder_date ON messages(folder_id, date DESC);
  CREATE INDEX idx_messages_user_date ON messages(user_id, date DESC);
  CREATE INDEX idx_messages_thread ON messages(thread_id);
  CREATE INDEX idx_messages_msgid ON messages(account_id, message_id);
  CREATE INDEX idx_messages_snooze ON messages(snoozed_until) WHERE snoozed_until IS NOT NULL;
  CREATE VIRTUAL TABLE messages_fts USING fts5(subject, sender, recipients, body, tokenize='unicode61 remove_diacritics 2');

  CREATE TABLE ai_insights (
    message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    summary TEXT, category TEXT, priority INTEGER, priority_reason TEXT, needs_reply INTEGER DEFAULT 0,
    action_items_json TEXT DEFAULT '[]', suggested_replies_json TEXT DEFAULT '[]', events_json TEXT DEFAULT '[]',
    sentiment TEXT, language TEXT, is_phishing INTEGER DEFAULT 0, draft_reply TEXT, model TEXT, created_at INTEGER
  );
  CREATE TABLE thread_summaries (
    user_id INTEGER, thread_id TEXT, summary TEXT, message_count INTEGER, model TEXT, updated_at INTEGER,
    PRIMARY KEY(user_id, thread_id)
  );
  CREATE TABLE embeddings (
    message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL, model TEXT, dim INTEGER, vector BLOB
  );
  CREATE INDEX idx_embeddings_user ON embeddings(user_id);
  CREATE TABLE ai_jobs (
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, type TEXT NOT NULL, ref_id TEXT, priority INTEGER DEFAULT 50,
    status TEXT DEFAULT 'queued', attempts INTEGER DEFAULT 0, error TEXT, run_after INTEGER DEFAULT 0,
    created_at INTEGER, updated_at INTEGER, UNIQUE(type, ref_id, user_id)
  );
  CREATE INDEX idx_ai_jobs_status ON ai_jobs(status, priority DESC, run_after);
  CREATE TABLE ai_providers (
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT, type TEXT NOT NULL, base_url TEXT, api_key_enc TEXT, default_model TEXT, embed_model TEXT,
    enabled INTEGER DEFAULT 1, created_at INTEGER
  );
  CREATE TABLE ai_usage (
    id INTEGER PRIMARY KEY, user_id INTEGER, provider_id INTEGER, model TEXT, task TEXT,
    input_tokens INTEGER, output_tokens INTEGER, ms INTEGER, ok INTEGER, created_at INTEGER
  );

  CREATE TABLE pending_ops (
    id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    op TEXT NOT NULL, payload_json TEXT, attempts INTEGER DEFAULT 0, error TEXT, created_at INTEGER
  );
  CREATE TABLE outbox (
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    payload_json TEXT NOT NULL, send_at INTEGER NOT NULL, status TEXT DEFAULT 'queued', error TEXT,
    attempts INTEGER DEFAULT 0, created_at INTEGER, sent_at INTEGER
  );
  CREATE TABLE drafts (
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, account_id INTEGER, payload_json TEXT, updated_at INTEGER
  );
  CREATE TABLE labels (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, name TEXT, color TEXT);
  CREATE TABLE rules (
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, name TEXT, enabled INTEGER DEFAULT 1, match_all INTEGER DEFAULT 1,
    account_id INTEGER, conditions_json TEXT DEFAULT '[]', actions_json TEXT DEFAULT '[]', stop INTEGER DEFAULT 0,
    sort_order INTEGER DEFAULT 0, created_at INTEGER
  );
  CREATE TABLE templates (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, name TEXT, subject TEXT, body_html TEXT);

  CREATE TABLE calendars (
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, account_id INTEGER,
    name TEXT, color TEXT, source TEXT DEFAULT 'local', url TEXT, ctag TEXT, sync_token TEXT,
    enabled INTEGER DEFAULT 1, is_default INTEGER DEFAULT 0, readonly INTEGER DEFAULT 0, created_at INTEGER
  );
  CREATE TABLE events (
    id INTEGER PRIMARY KEY, calendar_id INTEGER NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
    uid TEXT, title TEXT, description TEXT, location TEXT, start INTEGER, end INTEGER, all_day INTEGER DEFAULT 0,
    timezone TEXT, rrule TEXT, exdates_json TEXT DEFAULT '[]', recurrence_id INTEGER,
    attendees_json TEXT DEFAULT '[]', organizer_json TEXT, reminders_json TEXT DEFAULT '[15]',
    status TEXT DEFAULT 'confirmed', busy INTEGER DEFAULT 1, url TEXT, online_meeting TEXT,
    etag TEXT, href TEXT, dirty INTEGER DEFAULT 0, deleted INTEGER DEFAULT 0, source_message_id INTEGER,
    created_at INTEGER, updated_at INTEGER
  );
  CREATE INDEX idx_events_cal ON events(calendar_id, start);
  CREATE INDEX idx_events_uid ON events(uid);
  CREATE TABLE reminders_sent (event_id INTEGER, occurrence INTEGER, PRIMARY KEY(event_id, occurrence));

  CREATE TABLE address_books (
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, account_id INTEGER, name TEXT, source TEXT DEFAULT 'local',
    url TEXT, ctag TEXT, sync_token TEXT, readonly INTEGER DEFAULT 0, created_at INTEGER
  );
  CREATE TABLE contacts (
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    address_book_id INTEGER REFERENCES address_books(id) ON DELETE CASCADE,
    uid TEXT, display_name TEXT, first_name TEXT, last_name TEXT, nickname TEXT,
    emails_json TEXT DEFAULT '[]', phones_json TEXT DEFAULT '[]', addresses_json TEXT DEFAULT '[]',
    org TEXT, title TEXT, birthday TEXT, notes TEXT, photo TEXT, website TEXT,
    groups_json TEXT DEFAULT '[]', favorite INTEGER DEFAULT 0, auto_collected INTEGER DEFAULT 0,
    last_contacted INTEGER, contact_count INTEGER DEFAULT 0, etag TEXT, href TEXT, dirty INTEGER DEFAULT 0,
    deleted INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER
  );
  CREATE INDEX idx_contacts_user ON contacts(user_id, display_name);
  CREATE TABLE contact_emails (contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE, user_id INTEGER, email TEXT);
  CREATE INDEX idx_contact_emails ON contact_emails(user_id, email);

  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL, notes TEXT, due INTEGER, priority INTEGER DEFAULT 0, done INTEGER DEFAULT 0,
    completed_at INTEGER, list TEXT DEFAULT 'Tasks', source_message_id INTEGER, created_at INTEGER, updated_at INTEGER
  );
  CREATE TABLE briefs (user_id INTEGER, day TEXT, content_json TEXT, model TEXT, created_at INTEGER, PRIMARY KEY(user_id, day));
  CREATE TABLE chats (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, title TEXT, created_at INTEGER, updated_at INTEGER);
  CREATE TABLE chat_messages (
    id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    role TEXT, content TEXT, sources_json TEXT DEFAULT '[]', created_at INTEGER
  );
  `,
  // 2: destructive actions proposed by AI-driven rules wait here for the user's explicit approval.
  //    ai_status gains 'none' = not scheduled for analysis (sent mail, old mail, other folders).
  `
  CREATE TABLE ai_approvals (
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE, rule_id INTEGER, rule_name TEXT,
    action_json TEXT NOT NULL, status TEXT DEFAULT 'pending', created_at INTEGER, decided_at INTEGER
  );
  CREATE INDEX idx_ai_approvals_user ON ai_approvals(user_id, status);
  UPDATE messages SET ai_status = 'none' WHERE ai_status = 'pending' AND CAST(id AS TEXT) NOT IN
    (SELECT ref_id FROM ai_jobs WHERE type = 'analyze' AND status IN ('queued', 'running', 'waiting'));
  `,
  // 3: spaces (e.g. Work / Private) and the AI memory. A space is a label on accounts, calendars and address books;
  //    '' = shared by all spaces; NULL on calendars/books = inherit from their account.
  //    memory: embedded chunks of messages, thread summaries, events, contacts and facts. owner says what the
  //    row belongs to for scoping: 'a:<accountId>' | 'c:<calendarId>' | 'b:<addressBookId>' | 's:<space>'.
  //    The old one-vector-per-message table is replaced (vectors are regenerated by the backfill).
  `
  ALTER TABLE accounts ADD COLUMN space TEXT DEFAULT '';
  ALTER TABLE calendars ADD COLUMN space TEXT;
  ALTER TABLE address_books ADD COLUMN space TEXT;
  ALTER TABLE chats ADD COLUMN space TEXT DEFAULT '';
  CREATE TABLE memory (
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL, ref_id TEXT NOT NULL, chunk INTEGER DEFAULT 0, owner TEXT NOT NULL,
    text TEXT, date INTEGER, model TEXT, dim INTEGER, vector BLOB, created_at INTEGER,
    UNIQUE(user_id, kind, ref_id, chunk)
  );
  CREATE INDEX idx_memory_ref ON memory(user_id, kind, ref_id);
  CREATE TABLE facts (
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    owner TEXT NOT NULL, text TEXT NOT NULL, origin TEXT DEFAULT 'auto', source_message_id INTEGER, created_at INTEGER
  );
  CREATE INDEX idx_facts_user ON facts(user_id, owner);
  DROP TABLE embeddings;
  DELETE FROM ai_jobs WHERE type = 'embed';
  `,
  // 4: insights can expire (login codes etc.) and list emails the sender asks the user to forward; the user's
  //    corrections (important / not important / spam / category) are kept to personalise future analysis.
  `
  ALTER TABLE ai_insights ADD COLUMN expires_at INTEGER;
  ALTER TABLE ai_insights ADD COLUMN requests_json TEXT;
  CREATE TABLE ai_feedback (
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id INTEGER, from_addr TEXT, domain TEXT, subject TEXT, kind TEXT NOT NULL, value TEXT, created_at INTEGER
  );
  CREATE INDEX idx_ai_feedback_sender ON ai_feedback(user_id, from_addr);
  CREATE INDEX idx_ai_feedback_domain ON ai_feedback(user_id, domain);
  `,
  // 5: dynamic AI topics (ongoing projects / cases) and items the user dismissed from the brief / priority views.
  `
  ALTER TABLE ai_insights ADD COLUMN topic TEXT;
  ALTER TABLE ai_insights ADD COLUMN dismissed_at INTEGER;
  CREATE INDEX idx_ai_insights_topic ON ai_insights(topic);
  `,
  // 6: drafts know their reply target and their copy in the IMAP Drafts folder; "needs reply" can be set by the
  //    user (and then survives re-analysis); jobs can carry options (e.g. quiet analysis of old mail).
  `
  ALTER TABLE drafts ADD COLUMN in_reply_to INTEGER;
  ALTER TABLE drafts ADD COLUMN server_msgid TEXT;
  CREATE INDEX idx_drafts_reply ON drafts(user_id, in_reply_to);
  ALTER TABLE ai_insights ADD COLUMN needs_reply_user INTEGER;
  ALTER TABLE ai_jobs ADD COLUMN options_json TEXT;
  UPDATE drafts SET in_reply_to = json_extract(payload_json, '$.inReplyToId');
  `,
  // 7: mail that needs an action other than a reply (pay, sign, register, review…), with a one-line description.
  `
  ALTER TABLE ai_insights ADD COLUMN needs_action INTEGER DEFAULT 0;
  ALTER TABLE ai_insights ADD COLUMN action_summary TEXT;
  `,
  // 8: mail history. The first sync takes recent mail quickly; older mail is downloaded afterwards in batches,
  //    back to the account's sync_history ('90' | '365' | 'all' days). folders.server_total = messages on the server.
  `
  ALTER TABLE accounts ADD COLUMN sync_history TEXT DEFAULT '90';
  ALTER TABLE folders ADD COLUMN server_total INTEGER;
  ALTER TABLE folders ADD COLUMN oldest_uid INTEGER;
  ALTER TABLE folders ADD COLUMN history_done INTEGER DEFAULT 0;
  UPDATE folders SET oldest_uid = (SELECT MIN(uid) FROM messages WHERE folder_id = folders.id AND uid IS NOT NULL);
  `,
  // 9: forwarded messages ($Forwarded keyword, as set by Outlook / Thunderbird / Apple Mail).
  `
  ALTER TABLE messages ADD COLUMN is_forwarded INTEGER DEFAULT 0;
  `,
  // 10: conversation grouping by subject when reply headers are missing (util/subject.js), indexes for the lookups
  //     done on every incoming message and for list views, and a small key/value table for one-time jobs.
  `
  ALTER TABLE messages ADD COLUMN subject_key TEXT;
  CREATE INDEX idx_messages_subject ON messages(user_id, subject_key);
  CREATE INDEX idx_messages_user_msgid ON messages(user_id, message_id);
  CREATE INDEX idx_messages_user_reply ON messages(user_id, in_reply_to);
  CREATE INDEX idx_messages_user_thread ON messages(user_id, thread_id, date DESC);
  CREATE INDEX idx_messages_folder_unread ON messages(folder_id, is_read, snoozed_until, thread_id, user_id, account_id);
  -- Lists walk this index without touching the rows (bodies are stored inline, so row reads are expensive).
  CREATE INDEX idx_messages_list ON messages(user_id, date DESC, thread_id, folder_id, account_id, is_read, is_flagged,
    has_attachments, snoozed_until, is_answered);
  CREATE TABLE app_state (key TEXT PRIMARY KEY, value TEXT);
  -- Analyses of messages removed by sync (not by the user), kept a week by Message-ID: mail that comes back (folder
  -- re-created, UIDVALIDITY reset, moved by another client) gets its analysis back instead of a new AI run.
  CREATE TABLE insight_archive (user_id INTEGER NOT NULL, msgid TEXT NOT NULL, data_json TEXT, created_at INTEGER, PRIMARY KEY (user_id, msgid));
  `,
  // 11: copies stored by Halcyon itself (sent mail) until the server's copy is seen — never cleaned up as stale;
  //     drafts are saved to the server automatically (server_saved_at = last version stored there).
  `
  ALTER TABLE messages ADD COLUMN local_copy INTEGER DEFAULT 0;
  ALTER TABLE drafts ADD COLUMN server_saved_at INTEGER;
  UPDATE messages SET local_copy = 1 WHERE uid IS NULL AND folder_id IN (SELECT id FROM folders WHERE special_use = '\\Sent');
  `,
  // 12: indexes for status queries that are polled (problems indicator, Settings → AI): without them each poll read
  //     the whole mailbox / memory (row columns after the bodies and vectors are expensive to reach).
  `
  CREATE INDEX idx_messages_local_copy ON messages(account_id, created_at) WHERE local_copy = 1 AND uid IS NULL;
  CREATE INDEX idx_memory_stats ON memory(user_id, kind, model, ref_id);
  CREATE INDEX idx_ai_jobs_user ON ai_jobs(user_id, type, status, ref_id);
  `,
  // 13: the zone a task's due time was read in by the server ("tomorrow at 10", a date from an email); NULL when the
  //     user picked the time in the browser. Lets a time-zone correction fix the former without moving the latter.
  `
  ALTER TABLE tasks ADD COLUMN due_tz TEXT;
  `,
  // 14: extra read-only calendars from CalDAV servers that are not a mail account (Nextcloud, iCloud, a colleague's
  //     shared calendar, …); each source can hold several calendars. Sync errors are kept for the problems panel.
  `
  CREATE TABLE calendar_sources (
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT, url TEXT NOT NULL,
    dav_user TEXT, dav_pass_enc TEXT, space TEXT, last_sync_at INTEGER, error TEXT, created_at INTEGER
  );
  ALTER TABLE calendars ADD COLUMN source_id INTEGER REFERENCES calendar_sources(id) ON DELETE CASCADE;
  ALTER TABLE calendars ADD COLUMN sync_error TEXT;
  ALTER TABLE calendars ADD COLUMN last_sync_at INTEGER;
  `,
  // 15: how a calendar's events count: 'busy' (block time: overlaps, free slots, scheduling), 'free' (shown, never
  //     block time) or 'info' (shown faintly, never block time, no reminders, not in the daily brief).
  `
  ALTER TABLE calendars ADD COLUMN show_as TEXT DEFAULT 'busy';
  `,
  // 16: who actually sent a message when it is not the From address ("Ana on behalf of Director"): the Sender header,
  //     JSON { name, address }; '' when there is none worth showing (mailing lists, bounce addresses). NULL = not
  //     read yet (older mail; filled in when the message is opened).
  `
  ALTER TABLE messages ADD COLUMN sender_json TEXT;
  `,
  // 17: how a requested action was settled: 'done' or 'skipped' (the user decided not to act), when dismissed_at is set.
  `
  ALTER TABLE ai_insights ADD COLUMN resolution TEXT;
  UPDATE ai_insights SET resolution = 'done' WHERE dismissed_at IS NOT NULL AND needs_action = 1;
  `,
  // 18: the calendar accepted invitations go to, per mail account (NULL = automatic: the account's own calendar).
  `
  ALTER TABLE accounts ADD COLUMN invite_calendar_id INTEGER;
  `,
  // 19: what the AI knows about each person the user corresponds with (ai/profiles.js): who they are, what is discussed,
  //     how the user writes to them; user_notes are the user's own corrections and always win.
  `
  CREATE TABLE contact_profiles (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, email TEXT NOT NULL, name TEXT,
    profile_json TEXT, user_notes TEXT, msg_count INTEGER DEFAULT 0, built_count INTEGER DEFAULT 0, last_message_at INTEGER,
    built_at INTEGER, PRIMARY KEY (user_id, email)
  );
  CREATE INDEX idx_messages_user_from ON messages(user_id, from_addr, date DESC);
  `,
  // 20: the user's email that answered / completed an open request (set by the conversation rule or by the AI when it
  //     analyses sent mail, which may be a new conversation, another subject or more people) — shown, and undoable.
  `
  ALTER TABLE ai_insights ADD COLUMN resolved_by INTEGER;
  `,
  // 21: read-only sessions (for looking at real mail, e.g. while getting support): the server refuses every change.
  `
  ALTER TABLE sessions ADD COLUMN read_only INTEGER DEFAULT 0;
  `,
  // 22: shared spaces (shared.js): a user of kind 'shared' owns the shared mail account, calendar, contacts and tasks;
  //     nobody signs in as it — its members act as it (cookie halcyon_as), so its data is synced and analysed once.
  `
  ALTER TABLE users ADD COLUMN kind TEXT DEFAULT 'person';
  CREATE TABLE shared_members (
    shared_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT DEFAULT 'member', created_at INTEGER, PRIMARY KEY (shared_id, user_id)
  );
  CREATE INDEX idx_shared_members_user ON shared_members(user_id);
  ALTER TABLE chats ADD COLUMN author_id INTEGER;
  `,
  // 23: assistants connected over MCP (mcp/server.js): one token per assistant, for the user's own mail or one shared
  //     space (target_id), optionally one space label; access 'read' or 'propose' (drafts, tasks, approval requests).
  `
  CREATE TABLE mcp_tokens (
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, target_id INTEGER NOT NULL,
    name TEXT, token_hash TEXT NOT NULL UNIQUE, access TEXT DEFAULT 'read', space TEXT DEFAULT '',
    created_at INTEGER, last_used_at INTEGER, revoked_at INTEGER
  );
  CREATE TABLE mcp_log (id INTEGER PRIMARY KEY, token_id INTEGER NOT NULL REFERENCES mcp_tokens(id) ON DELETE CASCADE, tool TEXT, detail TEXT, ok INTEGER, at INTEGER);
  CREATE INDEX idx_mcp_log_token ON mcp_log(token_id, at DESC);
  `,
  // 24: the user's reason for a correction ("only fake conferences — they …"): a rule the AI applies to similar mail
  //     (ai/learning.js), instead of a blanket rule for the sender.
  `
  ALTER TABLE ai_feedback ADD COLUMN reason TEXT;
  `,
  // 25: context per mail account (who the user is in it — work, private, business): the user's own words and what was
  //     learned from that account's sent mail. Mail of one account is handled with only its own context.
  `
  ALTER TABLE accounts ADD COLUMN about_me TEXT;
  ALTER TABLE accounts ADD COLUMN learned_about TEXT;
  ALTER TABLE accounts ADD COLUMN learned_about_at INTEGER;
  `,
  // 26: the user's own categories (ai/custom.js): described in words (the AI assigns mail to them) and/or a saved
  //     search. message_tags.source: 'ai' | 'user' (added by hand) | 'no' (removed by hand — the AI does not re-add).
  `
  CREATE TABLE custom_categories (
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, color TEXT,
    description TEXT, query TEXT, account_id INTEGER, sort_order INTEGER DEFAULT 0, created_at INTEGER, scanned_at INTEGER
  );
  CREATE TABLE message_tags (
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE, category_id INTEGER NOT NULL REFERENCES custom_categories(id) ON DELETE CASCADE,
    source TEXT DEFAULT 'ai', created_at INTEGER, PRIMARY KEY (message_id, category_id)
  );
  CREATE INDEX idx_message_tags_cat ON message_tags(category_id, source);
  `,
  // 27: per account: which picture of the user the AI uses for its mail (NULL = the general setting ai.contextMode);
  //     linked event copies (an event from a read-only / info / shared calendar added to the user's own calendar,
  //     following the original: its calendar + uid), see calendar/linked.js.
  `
  ALTER TABLE accounts ADD COLUMN context_mode TEXT;
  ALTER TABLE events ADD COLUMN linked_cal_id INTEGER;
  ALTER TABLE events ADD COLUMN linked_uid TEXT;
  ALTER TABLE events ADD COLUMN linked_at INTEGER;
  CREATE INDEX idx_events_linked ON events(linked_cal_id, linked_uid) WHERE linked_cal_id IS NOT NULL;
  `,
  // 28: automatic replies per account (+ who got one when), muted conversations, quick steps (mail/extras.js).
  `
  ALTER TABLE accounts ADD COLUMN auto_reply_json TEXT;
  CREATE TABLE auto_replied (account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, address TEXT NOT NULL, at INTEGER, PRIMARY KEY (account_id, address));
  CREATE TABLE muted_threads (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, thread_id TEXT NOT NULL, created_at INTEGER, PRIMARY KEY (user_id, thread_id));
  CREATE TABLE quick_steps (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, actions_json TEXT, sort_order INTEGER DEFAULT 0, created_at INTEGER);
  `,
  // 29: the user's own email waits for an answer (asked something / requested something) — "Waiting for a reply".
  `
  ALTER TABLE ai_insights ADD COLUMN expects_reply INTEGER DEFAULT 0;
  `,
  // 30: Web Push subscriptions (phones, browsers, the Android app), see notifications.js.
  `
  CREATE TABLE push_subscriptions (
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, endpoint TEXT NOT NULL UNIQUE,
    keys_json TEXT NOT NULL, device TEXT, created_at INTEGER, last_ok_at INTEGER
  );
  `,
  // 31: each action item of an email settled on its own ({ "<item text, lower case>": { resolution, at } }).
  `ALTER TABLE ai_insights ADD COLUMN action_state_json TEXT;`,
  // 32: archives — mailboxes kept by Halcyon itself, on no mail server (imported Outlook data files, mail moved out of
  // a mailbox); their imports / moves run as jobs.
  `
  ALTER TABLE accounts ADD COLUMN kind TEXT DEFAULT 'mail';
  CREATE TABLE archive_jobs (
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
    type TEXT NOT NULL, format TEXT, file_path TEXT, file_name TEXT, keep_file INTEGER DEFAULT 0, params_json TEXT,
    status TEXT DEFAULT 'queued', done INTEGER DEFAULT 0, total INTEGER, skipped INTEGER DEFAULT 0, failed INTEGER DEFAULT 0, error TEXT,
    created_at INTEGER, finished_at INTEGER
  );
  `,
  // 33: an account's services are separate — mail (IMAP/SMTP) is one of them (a calendar-only or contacts-only
  // account has mail = 0); a default address book.
  `
  ALTER TABLE accounts ADD COLUMN mail INTEGER DEFAULT 1;
  ALTER TABLE address_books ADD COLUMN is_default INTEGER DEFAULT 0;
  `,
  // 34: servers with their own certificates (self-signed, a private CA): trusted per account — a CA (PEM) added to
  // the usual ones, or (insecure) not checked.
  `
  ALTER TABLE accounts ADD COLUMN tls_ca TEXT;
  ALTER TABLE accounts ADD COLUMN tls_insecure INTEGER DEFAULT 0;
  `,
  // 35: problems the user put aside (hidden while they stay the same; forgotten once the problem is gone).
  `
  CREATE TABLE problem_dismissals (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, key TEXT NOT NULL, sig TEXT, at INTEGER, PRIMARY KEY (user_id, key)
  );
  `,
  // 36: task lists — kept in Halcyon or synced with a CalDAV collection (VTODO); each in a space like calendars, one
  // the default. Tasks: their list, recurrence (RRULE), date-only due, and what CalDAV sync needs (uid, href, etag,
  // dirty, the server's VTODO as it was so other clients' properties survive). Deletions wait in task_deletions
  // until the server has them. Existing tasks move into a list per former list name.
  `
  CREATE TABLE task_lists (
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
    name TEXT, color TEXT, source TEXT DEFAULT 'local', url TEXT, ctag TEXT, readonly INTEGER DEFAULT 0, is_default INTEGER DEFAULT 0,
    space TEXT, sync_error TEXT, created_at INTEGER
  );
  ALTER TABLE tasks ADD COLUMN list_id INTEGER REFERENCES task_lists(id) ON DELETE CASCADE;
  ALTER TABLE tasks ADD COLUMN rrule TEXT;
  ALTER TABLE tasks ADD COLUMN due_all_day INTEGER DEFAULT 0;
  ALTER TABLE tasks ADD COLUMN uid TEXT;
  ALTER TABLE tasks ADD COLUMN href TEXT;
  ALTER TABLE tasks ADD COLUMN etag TEXT;
  ALTER TABLE tasks ADD COLUMN dirty INTEGER DEFAULT 0;
  ALTER TABLE tasks ADD COLUMN ics TEXT;
  CREATE INDEX idx_tasks_list ON tasks(list_id);
  CREATE TABLE task_deletions (id INTEGER PRIMARY KEY, list_id INTEGER NOT NULL REFERENCES task_lists(id) ON DELETE CASCADE, href TEXT NOT NULL, etag TEXT);
  INSERT INTO task_lists (user_id, name, source, created_at) SELECT DISTINCT user_id, COALESCE(NULLIF(list, ''), 'Tasks'), 'local', CAST(strftime('%s', 'now') AS INTEGER) * 1000 FROM tasks;
  UPDATE tasks SET list_id = (SELECT l.id FROM task_lists l WHERE l.user_id = tasks.user_id AND l.name = COALESCE(NULLIF(tasks.list, ''), 'Tasks'));
  UPDATE task_lists SET is_default = 1 WHERE id IN (SELECT MIN(id) FROM task_lists GROUP BY user_id);
  `,
  // 37: calendars, task lists and address books from a server can be hidden (removed from view, still synced, shown
  // again any time) — deleting their row only made them come back with the next sync.
  `
  ALTER TABLE calendars ADD COLUMN hidden INTEGER DEFAULT 0;
  ALTER TABLE task_lists ADD COLUMN hidden INTEGER DEFAULT 0;
  ALTER TABLE address_books ADD COLUMN hidden INTEGER DEFAULT 0;
  `,
  // 38: failed server changes and sends that could not reach the server are tried again automatically, with growing
  // pauses (scheduler.js autoRetry): how often already, and when next.
  `
  ALTER TABLE pending_ops ADD COLUMN auto_retries INTEGER DEFAULT 0;
  ALTER TABLE pending_ops ADD COLUMN next_retry_at INTEGER;
  ALTER TABLE outbox ADD COLUMN auto_retries INTEGER DEFAULT 0;
  `,
];

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
];

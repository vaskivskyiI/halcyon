// Files attached to a message being written: uploaded once and kept on disk, so drafts refer to them ({uploadId})
// instead of carrying them (autosave stays small, and no attachment is left out of a saved draft).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { all, now } from '../db/index.js';
import { config } from '../config.js';

const root = path.join(config.dataDir, 'uploads');
const dirOf = (userId) => path.join(root, String(Number(userId)));
const valid = (id) => /^[a-f0-9]{32}$/.test(String(id || ''));
export const MAX_UPLOAD = 25 * 1024 * 1024;

export function saveUpload(userId, { filename, contentType, content }) {
  if (content.length > MAX_UPLOAD) throw new Error('Attachments can be at most 25 MB');
  const id = crypto.randomBytes(16).toString('hex');
  fs.mkdirSync(dirOf(userId), { recursive: true });
  fs.writeFileSync(path.join(dirOf(userId), `${id}.bin`), content);
  fs.writeFileSync(path.join(dirOf(userId), `${id}.json`), JSON.stringify({ filename: String(filename || 'attachment').slice(0, 200), contentType: contentType || 'application/octet-stream', size: content.length, at: now() }));
  return { uploadId: id, filename: String(filename || 'attachment').slice(0, 200), contentType: contentType || 'application/octet-stream', size: content.length };
}

/** { meta, content } of the user's upload, or null. */
export function readUpload(userId, id) {
  if (!valid(id)) return null;
  const base = path.join(dirOf(userId), id);
  try { return { meta: JSON.parse(fs.readFileSync(`${base}.json`, 'utf8')), content: fs.readFileSync(`${base}.bin`) }; } catch { return null; }
}

/** Uploads no draft or unsent message refers to any more, older than two days, are removed (daily). */
export function cleanUploads() {
  if (!fs.existsSync(root)) return 0;
  const used = new Set();
  for (const r of [...all('SELECT payload_json AS p FROM drafts'), ...all("SELECT payload_json AS p FROM outbox WHERE status != 'sent' OR sent_at > ?", now() - 864e5)]) {
    for (const m of String(r.p || '').matchAll(/"uploadId":"([a-f0-9]{32})"/g)) used.add(m[1]);
  }
  let n = 0;
  for (const u of fs.readdirSync(root)) {
    for (const f of fs.readdirSync(path.join(root, u)).filter((x) => x.endsWith('.json'))) {
      const id = f.slice(0, -5);
      const file = path.join(root, u, f);
      if (used.has(id) || now() - fs.statSync(file).mtimeMs < 2 * 864e5) continue;
      for (const ext of ['.json', '.bin']) fs.rmSync(path.join(root, u, id + ext), { force: true });
      n++;
    }
  }
  return n;
}

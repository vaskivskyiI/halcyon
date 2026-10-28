// Archives (see mail/archive.js): list / create, import files into them, move mail into them, export them.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { get, all } from '../db/index.js';
import { requireUser } from '../auth.js';
import { httpError, ids } from './util.js';
import { config } from '../config.js';
import { userAccounts } from '../accounts.js';
import { scope, reqSpace } from '../spaces.js';
import { createArchive, archiveOf, queueJob, jobOut, importDir } from '../mail/archive.js';
import '../mail/importers.js';
import { readRaw } from '../mail/store.js';
import { zipStream } from '../util/zip.js';

const FORMATS = { pst: 'pst', ost: 'ost', mbox: 'mbox', mbx: 'mbox', eml: 'eml', zip: 'zip' };
const formatOf = (name, given) => FORMATS[String(given || '').toLowerCase()] || FORMATS[String(name || '').split('.').pop().toLowerCase()] || null;
const safe = (s) => String(s || '').replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'message';

export default async function archiveRoutes(app) {
  app.addHook('preHandler', requireUser);
  // Uploads of (possibly very large) files are streamed to disk, not read into memory.
  app.addContentTypeParser('application/octet-stream', (req, payload, done) => done(null));

  app.get('/api/archives', async (req) => {
    const sc = scope(req.user.id, reqSpace(req));
    const list = userAccounts(req.user.id).filter((a) => a.kind === 'archive' && (!sc || sc.accountIds.includes(a.id)));
    return {
      archives: list.map((a) => ({
        id: a.id, name: a.name, space: a.space || '', color: a.color,
        ...get('SELECT COUNT(*) AS messages, COALESCE(SUM(size), 0) AS bytes FROM messages WHERE account_id = ?', a.id),
        folders: all('SELECT id, path, name, total FROM folders WHERE account_id = ? ORDER BY path', a.id),
      })),
      jobs: all('SELECT * FROM archive_jobs WHERE user_id = ? ORDER BY id DESC LIMIT 20', req.user.id).map(jobOut),
      // Files on this computer can be named by path only in the desktop app's own local server.
      localFiles: config.singleUser,
    };
  });

  app.post('/api/archives', async (req) => {
    const a = createArchive(req.user.id, { name: req.body?.name, space: req.body?.space ?? reqSpace(req) ?? '' });
    return { id: a.id, name: a.name };
  });

  app.get('/api/archives/jobs', async (req) => all('SELECT * FROM archive_jobs WHERE user_id = ? ORDER BY id DESC LIMIT 20', req.user.id).map(jobOut));

  // A file into an archive: uploaded (body = the file, ?filename=…), or — desktop app on this computer only — read
  // where it is ({ path }), so a large Outlook data file is not copied first.
  app.post('/api/archives/:id/import', async (req, reply) => {
    const a = archiveOf(req.user.id, req.params.id);
    if (!a) return httpError(reply, 404, 'Archive not found');
    const folder = String(req.query.folder || req.body?.folder || '').trim().slice(0, 200) || null;
    if (req.headers['content-type']?.startsWith('application/octet-stream')) {
      const name = path.basename(String(req.query.filename || 'import'));
      const format = formatOf(name, req.query.format);
      if (!format) return httpError(reply, 400, 'Unknown file type — use .pst, .ost, .mbox, .eml or .zip');
      const file = path.join(importDir(), `${crypto.randomBytes(6).toString('hex')}-${name.replace(/[^\w.-]+/g, '_')}`);
      try { await pipeline(req.raw, fs.createWriteStream(file)); } catch (e) { fs.rmSync(file, { force: true }); return httpError(reply, 400, `Upload interrupted: ${e.message}`); }
      return queueJob(req.user.id, a.id, 'import', { format, filePath: file, fileName: name, params: { folder } });
    }
    const p = String(req.body?.path || '');
    if (!config.singleUser) return httpError(reply, 400, 'Upload the file instead');
    if (!p || !path.isAbsolute(p) || !fs.existsSync(p) || !fs.statSync(p).isFile()) return httpError(reply, 400, 'File not found');
    const format = formatOf(p, req.body?.format);
    if (!format) return httpError(reply, 400, 'Unknown file type — use .pst, .ost, .mbox, .eml or .zip');
    return queueJob(req.user.id, a.id, 'import', { format, filePath: p, fileName: path.basename(p), keepFile: true, params: { folder } });
  });

  // Mail into an archive: chosen messages, or a folder's mail older than a date. Copied and checked, then the
  // mailbox copy goes to Trash (keep: copy only).
  app.post('/api/archives/:id/move', async (req, reply) => {
    const a = archiveOf(req.user.id, req.params.id);
    if (!a) return httpError(reply, 404, 'Archive not found');
    const b = req.body || {};
    const list = ids(b.ids);
    const folderId = b.folderId && get('SELECT f.id FROM folders f JOIN accounts x ON x.id = f.account_id WHERE f.id = ? AND x.user_id = ?', b.folderId, req.user.id)?.id;
    if (!list.length && !folderId) return httpError(reply, 400, 'Nothing to archive');
    return queueJob(req.user.id, a.id, 'move', { params: { ids: list, folderId, before: Number(b.before) || null, folderPath: b.folderPath ? String(b.folderPath).slice(0, 200) : null, keep: !!b.keep } });
  });

  // A folder (any, not only an archive's) or a whole archive as a ZIP of .eml files, its folders kept: opens in
  // Windows Explorer, the emails can be dragged into Outlook, Thunderbird or another program, or imported back here.
  app.get('/api/archives/export', async (req, reply) => {
    const folderId = Number(req.query.folderId) || null;
    const archive = !folderId && archiveOf(req.user.id, req.query.archiveId);
    const folders = folderId
      ? all('SELECT f.* FROM folders f JOIN accounts a ON a.id = f.account_id WHERE f.id = ? AND a.user_id = ?', folderId, req.user.id)
      : archive ? all('SELECT * FROM folders WHERE account_id = ?', archive.id) : [];
    if (!folders.length) return httpError(reply, 404, 'Not found');
    const title = folderId ? folders[0].name : archive.name;
    async function* entries() {
      for (const f of folders) {
        const dir = folderId ? '' : `${(f.delimiter && f.delimiter !== '/' ? f.path.split(f.delimiter) : f.path.split('/')).map(safe).join('/')}/`;
        const used = new Set();
        for (const m of all('SELECT id, date, subject, raw_path FROM messages WHERE folder_id = ? ORDER BY date', f.id)) {
          const raw = readRaw(m);
          if (!raw) continue;
          const d = new Date(m.date);
          let name = `${d.toISOString().slice(0, 10)} ${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')} ${safe(m.subject || '(no subject)')}`;
          if (used.has(name)) name += ` (${m.id})`;
          used.add(name);
          yield { name: `${dir}${name}.eml`, data: raw, date: m.date };
        }
      }
    }
    reply.header('content-type', 'application/zip').header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${safe(title)}.zip`)}`);
    return reply.send(Readable.from(zipStream(entries())));
  });
}

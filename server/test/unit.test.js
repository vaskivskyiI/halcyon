import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

process.env.HALCYON_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-unit-'));
const { makeProvider } = await import('../src/ai/providers/index.js');
const { parseJSON } = await import('../src/ai/router.js');
const { parseVCards, toVCard } = await import('../src/contacts/vcard.js');
const { parseIcs, buildIcs } = await import('../src/calendar/ics.js');
const { expand, tzOffsetMs } = await import('../src/calendar/recurrence.js');
const { parseQuery } = await import('../src/search.js');
const { stripQuoted } = await import('../src/ai/prompts.js');
const { sanitizeEmailHtml } = await import('../src/mail/sanitize.js');

// Fake vendor endpoint: records requests and replies with the handler's output.
function fakeServer(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => { const r = { method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null }; seen.push(r); handler(r, res); });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() })));
}

test('ollama: chat, streaming, json format, embeddings, models', async () => {
  const s = await fakeServer((r, res) => {
    if (r.url === '/api/chat' && !r.body.stream) return res.end(JSON.stringify({ message: { content: '{"a":1}' }, prompt_eval_count: 10, eval_count: 3 }));
    if (r.url === '/api/chat') { res.write(JSON.stringify({ message: { content: 'Hel' } }) + '\n'); res.write(JSON.stringify({ message: { content: 'lo' } }) + '\n'); return res.end(JSON.stringify({ message: { content: '' }, done: true, prompt_eval_count: 5, eval_count: 2 }) + '\n'); }
    if (r.url === '/api/embed') return res.end(JSON.stringify({ embeddings: r.body.input.map(() => [0.1, 0.2]) }));
    if (r.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'llama3.1:8b' }, { name: 'nomic-embed-text' }] }));
  });
  const p = makeProvider({ type: 'ollama', baseUrl: s.url });
  const r1 = await p.chat({ model: 'm', system: 'sys', messages: [{ role: 'user', content: 'hi' }], json: true });
  assert.equal(r1.text, '{"a":1}');
  assert.equal(s.seen[0].body.format, 'json');
  assert.equal(s.seen[0].body.messages[0].role, 'system');
  let streamed = '';
  const r2 = await p.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], onToken: (t) => (streamed += t) });
  assert.equal(streamed, 'Hello'); assert.equal(r2.usage.output, 2);
  assert.deepEqual(await p.embed({ model: 'e', input: ['a', 'b'] }), [[0.1, 0.2], [0.1, 0.2]]);
  const models = await p.listModels();
  assert.equal(models.find((m) => m.id === 'nomic-embed-text').embedding, true);
  s.close();
});

test('openai-compatible: SSE streaming, json mode fallback, embeddings', async () => {
  let rejectJson = true;
  const s = await fakeServer((r, res) => {
    if (r.url === '/v1/chat/completions') {
      if (r.body.response_format && rejectJson) { res.statusCode = 400; return res.end(JSON.stringify({ error: { message: 'response_format not supported' } })); }
      if (!r.body.stream) return res.end(JSON.stringify({ choices: [{ message: { content: 'plain' } }], usage: { prompt_tokens: 4, completion_tokens: 1 } }));
      res.setHeader('content-type', 'text/event-stream');
      res.write('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":" there"}}]}\n\n');
      res.write('data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":2}}\n\n');
      return res.end('data: [DONE]\n\n');
    }
    if (r.url === '/v1/embeddings') return res.end(JSON.stringify({ data: [{ index: 1, embedding: [2] }, { index: 0, embedding: [1] }] }));
  });
  const p = makeProvider({ type: 'openai-compatible', baseUrl: `${s.url}/v1`, apiKey: 'k' });
  const r = await p.chat({ model: 'x', messages: [{ role: 'user', content: 'q' }], json: true });
  assert.equal(r.text, 'plain');
  assert.equal(s.seen[0].headers.authorization, 'Bearer k');
  assert.equal(s.seen[1].body.response_format, undefined, 'retried without response_format');
  let t = '';
  const r2 = await p.chat({ model: 'x', messages: [{ role: 'user', content: 'q' }], onToken: (x) => (t += x) });
  assert.equal(t, 'Hi there'); assert.equal(r2.usage.input, 7);
  assert.deepEqual(await p.embed({ model: 'e', input: ['a', 'b'] }), [[1], [2]]);
  s.close();
});

test('anthropic: messages API, role normalisation, SSE', async () => {
  const s = await fakeServer((r, res) => {
    if (!r.body.stream) return res.end(JSON.stringify({ content: [{ type: 'text', text: '{"ok":true}' }], usage: { input_tokens: 9, output_tokens: 4 } }));
    res.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":11}}}\n\n');
    res.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hey"}}\n\n');
    res.write('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":1}}\n\n');
    res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
  });
  const p = makeProvider({ type: 'anthropic', baseUrl: s.url, apiKey: 'sk' });
  const r = await p.chat({ model: 'claude-haiku-5-5', system: 'sys', messages: [{ role: 'assistant', content: 'a' }, { role: 'user', content: 'b' }, { role: 'user', content: 'c' }], json: true });
  assert.deepEqual(parseJSON(r.text), { ok: true });
  const req = s.seen[0];
  assert.equal(req.url, '/v1/messages');
  assert.equal(req.headers['x-api-key'], 'sk');
  assert.equal(req.headers['anthropic-version'], '2023-06-01');
  assert.equal(req.body.messages[0].role, 'user', 'must start with user');
  assert.equal(req.body.messages.at(-1).content, 'b\n\nc', 'consecutive roles merged');
  assert.match(req.body.system, /JSON/);
  let t = '';
  const r2 = await p.chat({ model: 'm', messages: [{ role: 'user', content: 'q' }], onToken: (x) => (t += x) });
  assert.equal(t, 'Hey'); assert.deepEqual(r2.usage, { input: 11, output: 1 });
  await assert.rejects(p.embed({ model: 'x', input: ['a'] }), /embeddings/);
  s.close();
});

test('gemini: generateContent, SSE streaming, batch embeddings', async () => {
  const s = await fakeServer((r, res) => {
    if (r.url.includes(':generateContent')) return res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'G' }] } }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 } }));
    if (r.url.includes(':streamGenerateContent')) { res.write('data: {"candidates":[{"content":{"parts":[{"text":"Ge"}]}}]}\n\n'); return res.end('data: {"candidates":[{"content":{"parts":[{"text":"mini"}]}}],"usageMetadata":{"promptTokenCount":2,"candidatesTokenCount":2}}\n\n'); }
    if (r.url.includes(':batchEmbedContents')) return res.end(JSON.stringify({ embeddings: r.body.requests.map(() => ({ values: [3] })) }));
  });
  const p = makeProvider({ type: 'gemini', baseUrl: s.url, apiKey: 'g' });
  const r = await p.chat({ model: 'gemini-2.5-flash', system: 'S', messages: [{ role: 'assistant', content: 'x' }, { role: 'user', content: 'y' }], json: true });
  assert.equal(r.text, 'G');
  assert.equal(s.seen[0].headers['x-goog-api-key'], 'g');
  assert.equal(s.seen[0].body.contents[0].role, 'model');
  assert.equal(s.seen[0].body.generationConfig.responseMimeType, 'application/json');
  let t = '';
  await p.chat({ model: 'm', messages: [{ role: 'user', content: 'q' }], onToken: (x) => (t += x) });
  assert.equal(t, 'Gemini');
  assert.deepEqual(await p.embed({ model: 'gemini-embedding-001', input: ['a', 'b'] }), [[3], [3]]);
  s.close();
});

test('provider errors are surfaced with status', async () => {
  const s = await fakeServer((r, res) => { res.statusCode = 401; res.end(JSON.stringify({ error: { message: 'bad key' } })); });
  const p = makeProvider({ type: 'openai', baseUrl: s.url, apiKey: 'k' });
  await assert.rejects(p.chat({ model: 'x', messages: [{ role: 'user', content: 'q' }] }), (e) => e.status === 401 && /bad key/.test(e.message));
  s.close();
  const dead = makeProvider({ type: 'ollama', baseUrl: 'http://127.0.0.1:1' });
  await assert.rejects(dead.chat({ model: 'x', messages: [{ role: 'user', content: 'q' }] }), /Cannot reach/);
});

test('parseJSON tolerates fences and prose', () => {
  assert.deepEqual(parseJSON('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJSON('Sure! Here it is: {"a":{"b":2}} hope it helps'), { a: { b: 2 } });
  assert.throws(() => parseJSON('nope'));
});

test('vCard round trip with folding, escaping, photo', () => {
  const c = { uid: 'u1', displayName: 'Ana Novak', firstName: 'Ana', lastName: 'Novak', emails: [{ type: 'work', value: 'ana@x.si' }], phones: [{ type: 'cell', value: '+386 1' }], addresses: [{ type: 'home', street: 'Jamova 39', city: 'Ljubljana', postal: '1000', country: 'Slovenia' }], org: 'IJS', notes: 'a;b,c\nnext '.repeat(10), groups: ['Work', 'VIP'], birthday: '1990-05-01', photo: 'data:image/png;base64,' + 'A'.repeat(200) };
  const back = parseVCards(toVCard(c))[0];
  for (const k of ['uid', 'displayName', 'firstName', 'lastName', 'org', 'notes', 'birthday', 'photo']) assert.equal(back[k], c[k], k);
  assert.deepEqual(back.groups, c.groups);
  assert.equal(back.addresses[0].city, 'Ljubljana');
  assert.equal(back.emails[0].value, 'ana@x.si');
});

test('ICS parse with VTIMEZONE and recurrence, build round trip', () => {
  const ics = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTIMEZONE\r\nTZID:Europe/Ljubljana\r\nBEGIN:STANDARD\r\nDTSTART:19701025T030000\r\nRRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU\r\nTZOFFSETFROM:+0200\r\nTZOFFSETTO:+0100\r\nEND:STANDARD\r\nBEGIN:DAYLIGHT\r\nDTSTART:19700329T020000\r\nRRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU\r\nTZOFFSETFROM:+0100\r\nTZOFFSETTO:+0200\r\nEND:DAYLIGHT\r\nEND:VTIMEZONE\r\nBEGIN:VEVENT\r\nUID:x1\r\nDTSTART;TZID=Europe/Ljubljana:20261020T090000\r\nDTEND;TZID=Europe/Ljubljana:20261020T100000\r\nRRULE:FREQ=WEEKLY;COUNT=4\r\nSUMMARY:Weekly\\, sync\r\nBEGIN:VALARM\r\nTRIGGER:-PT10M\r\nACTION:DISPLAY\r\nEND:VALARM\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
  const { events } = parseIcs(ics);
  const e = events[0];
  assert.equal(e.title, 'Weekly, sync');
  assert.equal(new Date(e.start).toISOString(), '2026-10-20T07:00:00.000Z');
  assert.deepEqual(e.reminders, [10]);
  assert.equal(e.timezone, 'Europe/Ljubljana');
  // Across the DST change on 2026-10-25 the wall-clock time stays 09:00 local (08:00Z).
  const occ = expand(e, e.start, e.start + 30 * 864e5);
  assert.equal(occ.length, 4);
  assert.equal(new Date(occ[1].start).toISOString(), '2026-10-27T08:00:00.000Z');
  const again = parseIcs(buildIcs([e])).events[0];
  assert.equal(again.rrule, 'FREQ=WEEKLY;COUNT=4');
  assert.equal(again.start, e.start);
});

test('tzOffsetMs', () => {
  assert.equal(tzOffsetMs('Europe/Ljubljana', Date.UTC(2026, 6, 1)), 2 * 3600e3);
  assert.equal(tzOffsetMs('Europe/Ljubljana', Date.UTC(2026, 0, 1)), 3600e3);
  assert.equal(tzOffsetMs('UTC', Date.now()), 0);
});

test('search query parsing', () => {
  const f = parseQuery('from:carol -is:read subject:"weekly report" budget "exact phrase" newer_than:7d');
  assert.equal(f.from[0].val, 'carol');
  assert.deepEqual(f.is[0], { val: 'read', neg: true });
  assert.equal(f.subject[0].val, 'weekly report');
  assert.deepEqual(f.terms, ['budget', 'exact phrase']);
  assert.equal(f.newer_than[0].val, '7d');
});

test('stripQuoted removes reply history', () => {
  const t = 'New text here.\n\nOn Mon, Jan 1, 2026 at 10:00 Bob <b@x> wrote:\n> old\n> older';
  assert.equal(stripQuoted(t), 'New text here.');
});

test('sanitizer removes active content and event handlers', () => {
  const { html } = sanitizeEmailHtml('<div onclick="x()">a</div><iframe src="x"></iframe><form><input></form><a href="javascript:alert(1)">l</a><img src="cid:abc">', { messageId: 7 });
  assert.ok(!/onclick|iframe|<form|<input|javascript:/i.test(html), html);
  assert.match(html, /\/api\/messages\/7\/cid\/abc/);
});

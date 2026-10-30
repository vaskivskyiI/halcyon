// A shared space shown with one's own: its calendars, tasks and contacts too, changed as the space, gone when set aside.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HALCYON_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r60-test-'));
process.env.HALCYON_LOG_LEVEL = 'error';

let app, base, ann = '', ben = '', space, ev, task, contact, cal, list, book, private_;
async function call(cookie, method, url, body, as) {
  const r = await fetch(base + url, { method, headers: { cookie, ...(as ? { 'x-halcyon-as': String(as) } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  return { status: r.status, data: await r.json(), cookie: sc ? sc.split(';')[0] : cookie };
}
const data = async (...a) => (await call(...a)).data;
const range = `from=${Date.UTC(2026, 10, 1)}&to=${Date.UTC(2026, 11, 1)}`;

before(async () => {
  const { buildServer } = await import('../src/index.js');
  app = await buildServer({ background: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  ann = (await call('', 'POST', '/api/auth/setup', { email: 'ann@example.org', name: 'Ann', password: 'password123' })).cookie;
  await call(ann, 'POST', '/api/admin/users', { email: 'ben@example.org', name: 'Ben', password: 'password123' });
  ben = (await call('', 'POST', '/api/auth/login', { email: 'ben@example.org', password: 'password123' })).cookie;
  space = (await data(ann, 'POST', '/api/shared', { name: 'Work' })).id;
  await call(ann, 'POST', `/api/shared/${space}/members`, { email: 'ben@example.org' });
  ev = (await data(ann, 'POST', '/api/events', { title: 'Team call', start: Date.UTC(2026, 10, 10, 9), end: Date.UTC(2026, 10, 10, 10) }, space)).id;
  task = (await data(ann, 'POST', '/api/tasks', { title: 'Send report' }, space)).id;
  contact = (await data(ann, 'POST', '/api/contacts', { displayName: 'Client One', emails: [{ value: 'client@work.example' }] }, space)).id;
  private_ = (await data(ben, 'POST', '/api/tasks', { title: 'Buy milk' })).id;
  await call(ben, 'PATCH', '/api/settings', { ui: { showShared: true } });
});
after(async () => { await app?.close(); setTimeout(() => process.exit(0), 50).unref(); });

test('calendars, events, tasks and contacts of the space stand next to one\'s own, marked', async () => {
  const cals = await data(ben, 'GET', '/api/calendars');
  cal = cals.find((c) => c.owner === space);
  assert.equal(cal.ownerName, 'Work');
  assert.equal(cal.isDefault, false, 'new things go to one\'s own by default');
  assert.ok(cals.some((c) => !c.owner));
  const e = (await data(ben, 'GET', `/api/events?${range}`)).find((x) => x.id === ev);
  assert.equal(e.owner, space);
  const tasks = await data(ben, 'GET', '/api/tasks');
  assert.equal(tasks.find((t) => t.id === task).owner, space);
  assert.ok(tasks.some((t) => t.id === private_ && !t.owner));
  list = (await data(ben, 'GET', '/api/task-lists')).find((l) => l.owner === space);
  assert.ok(list);
  book = (await data(ben, 'GET', '/api/address-books')).find((b) => b.owner === space);
  assert.ok(book);
  assert.equal((await data(ben, 'GET', '/api/contacts')).find((c) => c.id === contact).owner, space);
  assert.match(JSON.stringify(await data(ben, 'GET', '/api/contacts/autocomplete?q=client')), /client@work\.example/);
  assert.ok((await data(ben, 'GET', '/api/events/search?q=team')).some((x) => x.id === ev));
});

test('settings stay about one\'s own, and working inside the space shows only the space', async () => {
  assert.ok(!(await data(ben, 'GET', '/api/calendars?all=1')).some((c) => c.owner));
  assert.ok(!(await data(ben, 'GET', '/api/tasks', undefined, space)).some((t) => t.id === private_), 'one\'s private tasks stay out of the space');
});

test('changes are made as the space', async () => {
  assert.equal((await call(ben, 'PATCH', `/api/tasks/${task}`, { done: true }, space)).status, 200);
  assert.equal((await call(ben, 'PATCH', `/api/tasks/${task}`, { done: false })).status, 404, 'not as himself');
  assert.equal((await call(ben, 'PATCH', `/api/events/${ev}`, { title: 'Team sync' }, space)).status, 200);
  assert.equal((await call(ben, 'POST', '/api/tasks', { title: 'Shared one', listId: list.id }, space)).status, 200);
});

test('the other person\'s view does not change, and a space set aside leaves all of it', async () => {
  assert.ok(!(await data(ann, 'GET', '/api/tasks')).some((t) => t.id === task), 'Ann has not chosen to show it');
  await call(ben, 'PATCH', '/api/settings', { ui: { hiddenShared: [space] } });
  assert.ok(!(await data(ben, 'GET', '/api/calendars')).some((c) => c.owner));
  assert.ok(!(await data(ben, 'GET', `/api/events?${range}`)).some((e) => e.id === ev));
  assert.ok(!(await data(ben, 'GET', '/api/tasks')).some((t) => t.id === task));
  assert.ok(!(await data(ben, 'GET', '/api/contacts')).some((c) => c.id === contact));
});

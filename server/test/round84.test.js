// Plain-text or HTML messages; addresses in the text become links; the text part keeps paragraphs, lists and quotes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HALCYON_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r84-test-'));
process.env.HALCYON_LOG_LEVEL = 'error';

const { buildMime } = await import('../src/mail/send.js');
const { linkifyHtml, mailText, sanitizeEmailHtml } = await import('../src/mail/sanitize.js');
const { simpleParser } = await import('mailparser');
const account = { user_id: 1, email: 'me@example.org', display_name: 'Me', aliases_json: '[]' };
const html = '<p>Hi <span style="color: rgb(185, 28, 28);">there</span>, see https://example.org/a?b=1&amp;c=2.</p><ul><li>one</li><li>two</li></ul>'
  + '<p><a href="https://site.example">the site</a></p><div data-quote><blockquote><p>Earlier text</p></blockquote></div>';

test('HTML: colours kept, addresses linked, a readable text part', async () => {
  const m = await simpleParser(await buildMime(account, { to: ['you@example.org'], subject: 'S', html }));
  assert.match(m.html, /color: rgb\(185, 28, 28\)/);
  assert.match(m.html, /<a href="https:\/\/example\.org\/a\?b=1&amp;c=2">https:\/\/example\.org\/a\?b=1&amp;c=2<\/a>\./, 'the address is a link, the full stop is not part of it');
  assert.equal((m.html.match(/<a /g) || []).length, 2, 'an existing link is not linked twice');
  assert.match(m.text, /Hi there, see https:\/\/example\.org\/a\?b=1&c=2\./);
  assert.match(m.text, /\* one\n \* two/);
  assert.match(m.text, /the site <https:\/\/site\.example>/);
  assert.match(m.text, /^> Earlier text$/m, 'the quote as "> " lines');
});

test('plain text: no HTML part at all', async () => {
  const m = await simpleParser(await buildMime(account, { to: ['you@example.org'], subject: 'S', html, format: 'text' }));
  assert.equal(m.html, false);
  assert.match(m.text, /see https:\/\/example\.org/);
  assert.match(m.text, /^> Earlier text$/m);
});

test('linking leaves tags, styles and brackets alone; received mail gets links that open outside', () => {
  assert.equal(linkifyHtml('<style>a{background:url(http://x.example/i.png)}</style>'), '<style>a{background:url(http://x.example/i.png)}</style>');
  assert.equal(linkifyHtml('&lt;http://z.example&gt; and (www.w.example)'), '&lt;<a href="http://z.example">http://z.example</a>&gt; and (<a href="http://www.w.example">www.w.example</a>)');
  assert.equal(linkifyHtml('<img alt="https://a.example">'), '<img alt="https://a.example">');
  assert.match(sanitizeEmailHtml('<p>Go to https://shop.example/x</p>').html, /<a href="https:\/\/shop\.example\/x" target="_blank" rel="noopener noreferrer">/);
  assert.equal(mailText('<h1>Title</h1><p>Body</p>'), 'Title\n\nBody');
});

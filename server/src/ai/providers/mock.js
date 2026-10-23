// Deterministic offline provider used by tests and demo mode. Produces plausible structured output.
import crypto from 'node:crypto';

export function mock() {
  return {
    async chat({ system = '', messages, json, onToken }) {
      const last = messages[messages.length - 1]?.content || '';
      // Contact profile (ai/profiles.js): derived from the transcript, so tests can check what reaches the prompt.
      if (json && /build a short profile of a person/.test(system)) {
        const mine = last.split('\n\n').find((b) => /USER → them/.test(b)) || '';
        const greeting = (mine.split('\n')[1] || '').trim();
        const subjects = [...last.matchAll(/(?:USER → them|them → USER) · (.+)/g)].map((m) => m[1]);
        const text = JSON.stringify({ who: `Works with the user on ${subjects[0] || 'mail'}`, relationship: 'colleague', organisation: '', topics: [...new Set(subjects)].slice(0, 3),
          language: 'English', user_writing: greeting ? `Opens with "${greeting.slice(0, 40)}"` : '', their_style: 'brief', notes: [] });
        return { text, usage: { input: 1, output: 1 } };
      }
      // Second opinion (ai/verify.js): quotes the sentence with a question / a request word from THE EMAIL.
      if (json && /check another assistant's triage/.test(system)) {
        const sentences = last.slice(last.lastIndexOf('THE EMAIL:')).split(/\n\n/).slice(1).join('\n').split(/(?<=[.?!])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
        const ask = sentences.find((x) => /\?$/.test(x) && !/^(Subject|From|To|Date|Written):/.test(x)) || '';
        const task = sentences.find((x) => /\b(pay|sign|register|submit|approve|send me)\b/i.test(x) && !/^(Subject|From|To|Written):/.test(x)) || '';
        return { text: JSON.stringify({ reply_quote: ask, task_quote: task, task: task ? task.replace(/^(please|could you)\s+/i, '').slice(0, 60) : '' }), usage: { input: 1, output: 1 } };
      }
      // Which open requests the user's email answers (ai/verify.js): those whose subject the email mentions.
      if (json && /THE USER sent the email below/.test(system)) {
        const [reqs, mail] = last.split("THE USER'S EMAIL:");
        const answers = [...reqs.matchAll(/\[(\d+)\][^·\n]*· ([^—→\n]+)/g)].map((r) => ({ id: Number(r[1]), done: mail.toLowerCase().includes(r[2].trim().toLowerCase()) }));
        return { text: JSON.stringify({ answers }), usage: { input: 1, output: 1 } };
      }
      // Suggested reason for a correction: a rule naming features of the email (tests check what reaches the prompt).
      if (!json && /Suggest the user's likely reason/.test(system)) {
        const verdict = (system.match(/marked the email below as ([^.]+)\./) || [])[1] || '';
        return { text: `"Emails like this (${verdict}): ${/List-Unsubscribe/.test(last) ? 'bulk mail, ' : ''}${(last.match(/Subject: (.*)/) || [])[1] || ''}"`, usage: { input: 1, output: 1 } };
      }
      if (!json && /describe who they are professionally/.test(system)) return { text: '- Works on the projects named in the sent mail\n- Writes in English', usage: { input: 1, output: 1 } };
      // The email itself (after the earlier conversation and the "Sender…/Recipients…" notes), so these are not
      // mistaken for content.
      const cur = last.slice(Math.max(0, last.lastIndexOf('THE EMAIL TO ANALYSE')));
      const email = cur.slice(Math.max(0, cur.indexOf('From:')));
      let text;
      if (json) {
        const last = cur;
        const subject = (last.match(/Subject: (.*)/) || [])[1] || 'message';
        const urgent = /urgent|asap|today|deadline/i.test(last);
        const question = /\?/.test(last);
        text = JSON.stringify({
          summary: `About "${subject.slice(0, 60)}".`, category: /unsubscribe|newsletter/i.test(last) ? 'newsletter' : 'work',
          priority: urgent ? 85 : question ? 60 : 30, priority_reason: urgent ? 'Time-sensitive request' : 'Routine',
          needs_reply: question, action_items: urgent ? [{ text: 'Respond to request', due: null }] : [],
          events: [], suggested_replies: question ? ['Sounds good, thanks!', 'Let me check and get back to you.', 'Can we discuss this tomorrow?'] : [],
          sentiment: urgent ? 'urgent' : 'neutral', language: 'en', is_phishing: false,
          facts: (email.match(/[^.\n]* is the [^.\n]+/g) || []).slice(0, 3).map((x) => x.trim()),
          topic: (subject.match(/order \d+/i) || [null])[0],
          needs_action: /\b(pay|invoice|sign|register|submit|approve)\b/i.test(email),
          action_summary: (email.match(/\b(pay|sign|register|submit|approve)\b[^.\n]{0,40}/i) || [''])[0],
          // "Please forward me the email with …" → long words of the email body as search keywords.
          requested_items: /forward|posreduj|send me|pošlji/i.test(last)
            ? [{ description: 'requested email', keywords: [...new Set((last.split(/\n\n/).pop().match(/\p{L}{7,}/gu) || []).map((w) => w.toLowerCase()))].slice(0, 6) }] : [],
          subject: `Re: ${subject}`, body: 'Thanks for your message. I will follow up shortly.',
          resolves: [...(system.includes('OPEN REQUESTS') ? system.split('OPEN REQUESTS').pop() : '').matchAll(/\[(\d+)\][^·\n]*· ([^—→\n]+)/g)].filter((r) => email.toLowerCase().includes(r[2].trim().toLowerCase())).map((r) => Number(r[1])),
        });
      } else {
        text = `Here is a helpful response based on your request.\n\n${last.slice(0, 80).replace(/\n/g, ' ')}...`;
      }
      if (onToken) for (const w of text.match(/.{1,12}/gs)) onToken(w);
      return { text, usage: { input: Math.round(last.length / 4), output: Math.round(text.length / 4) } };
    },
    async embed({ input }) {
      // Hashing set-of-words embedding: texts sharing words get similar vectors (repetition does not dominate).
      return input.map((t) => {
        const v = new Array(256).fill(0);
        for (const w of String(t).toLowerCase().match(/[a-z0-9]{3,}/g) || []) v[crypto.createHash('md5').update(w).digest()[0]] = 1;
        return v;
      });
    },
    async listModels() { return [{ id: 'mock', embedding: true }]; },
  };
}

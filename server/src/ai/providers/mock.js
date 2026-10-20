// Deterministic offline provider used by tests and demo mode. Produces plausible structured output.
import crypto from 'node:crypto';

export function mock() {
  return {
    async chat({ messages, json, onToken }) {
      const last = messages[messages.length - 1]?.content || '';
      let text;
      if (json) {
        const subject = (last.match(/Subject: (.*)/) || [])[1] || 'message';
        const urgent = /urgent|asap|today|deadline/i.test(last);
        const question = /\?/.test(last);
        text = JSON.stringify({
          summary: `About "${subject.slice(0, 60)}".`, category: /unsubscribe|newsletter/i.test(last) ? 'newsletter' : 'work',
          priority: urgent ? 85 : question ? 60 : 30, priority_reason: urgent ? 'Time-sensitive request' : 'Routine',
          needs_reply: question, action_items: urgent ? [{ text: 'Respond to request', due: null }] : [],
          events: [], suggested_replies: question ? ['Sounds good, thanks!', 'Let me check and get back to you.', 'Can we discuss this tomorrow?'] : [],
          sentiment: urgent ? 'urgent' : 'neutral', language: 'en', is_phishing: false,
          facts: (last.match(/[^.\n]* is the [^.\n]+/g) || []).slice(0, 3).map((x) => x.trim()),
          subject: `Re: ${subject}`, body: 'Thanks for your message. I will follow up shortly.',
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

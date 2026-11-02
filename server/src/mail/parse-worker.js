// Worker thread: parses new mail for ingest and saves its original (mail/parse.js digestAndSave), off the thread that
// answers requests.
import { serve } from '../util/workers.js';
import { digestAndSave } from './parse.js';

serve({ digest: ({ raw, dir }) => digestAndSave(Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength), dir) });

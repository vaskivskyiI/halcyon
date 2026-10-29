import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { api } from '../api.js';
import { toast, toastError } from '../util.js';
import { Modal, Spinner } from './common.jsx';

const RANGES = [['90', 'Last 3 months'], ['365', 'Last year'], ['1095', 'Last 3 years'], ['all', 'Everything']];

/**
 * AI analysis started by hand for older mail of one folder (folderId) or one mailbox / archive (accountId): summaries,
 * facts, topics and the assistant's memory. Older than the open-items window → no "needs reply" (handled long ago).
 * Runs in the background, after new mail; can be stopped in Settings → AI.
 */
export default function AnalyzeOld({ folderId, accountId, name, onClose }) {
  const [days, setDays] = useState('365');
  const [missing, setMissing] = useState(true);
  const [count, setCount] = useState(null);
  const [busy, setBusy] = useState(false);
  const body = { folderId, accountId, days: days === 'all' ? 'all' : Number(days), mode: missing ? 'missing' : 'all' };
  useEffect(() => {
    setCount(null);
    api.post('/api/ai/reprocess', { ...body, count: true }).then((r) => setCount(r.count)).catch(toastError);
  }, [days, missing]);
  const start = async () => {
    setBusy(true);
    try {
      const r = await api.post('/api/ai/reprocess', body);
      toast(`${r.queued} email${r.queued === 1 ? '' : 's'} queued for analysis — new mail still comes first. Progress and Stop: Settings → AI.`);
      onClose();
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  return (
    <Modal title={`Analyse “${name}” with AI`} onClose={onClose} footer={<>
      <button className="btn ghost" onClick={onClose}>Cancel</button>
      <button className="btn ai" disabled={busy || !count} onClick={start}>{busy ? <Spinner size={14} /> : <Sparkles size={15} />} Analyse {count ?? '…'} email{count === 1 ? '' : 's'}</button>
    </>}>
      <div style={{ display: 'grid', gap: 10 }}>
        <label className="field">Which mail
          <select className="input" value={days} onChange={(e) => setDays(e.target.value)}>{RANGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        <label className="row small"><input type="checkbox" checked={missing} onChange={(e) => setMissing(e.target.checked)} /> Only emails not analysed yet</label>
        <div className="small muted">Summaries, topics and facts for search and the assistant. Emails older than your open-items window are not put into “Needs reply” or “Action needed” — they were most likely handled long ago. With a local model this can take a while; it runs in the background.</div>
      </div>
    </Modal>
  );
}

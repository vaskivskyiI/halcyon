import { useEffect, useState } from 'react';
import { Plus, Trash2, Play, Pencil, X } from 'lucide-react';
import { api } from '../api.js';
import { store } from '../store.js';
import { Modal, Switch } from '../components/common.jsx';
import { toast, toastError } from '../util.js';

const FIELDS = [['from', 'Sender'], ['to', 'Recipients'], ['subject', 'Subject'], ['body', 'Body'], ['any', 'Anywhere'], ['hasAttachment', 'Has attachment'], ['category', 'AI category'], ['priority', 'AI priority'], ['needsReply', 'AI: needs reply']];
const OPS = { text: [['contains', 'contains'], ['not_contains', "doesn't contain"], ['equals', 'is'], ['starts', 'starts with'], ['ends', 'ends with'], ['regex', 'matches regex']], bool: [['is', 'is']], num: [['gte', '≥'], ['lte', '≤']] };
const kind = (f) => (['hasAttachment', 'needsReply'].includes(f) ? 'bool' : f === 'priority' ? 'num' : 'text');
const CATS = ['personal', 'work', 'finance', 'shopping', 'travel', 'newsletter', 'promotion', 'social', 'notification', 'security', 'calendar', 'support', 'other'];
const AI_FIELDS = ['category', 'priority', 'needsReply'];
const GATED = ['trash', 'spam', 'forward'];
const ACTIONS = [['move', 'Move to folder'], ['archive', 'Archive'], ['markRead', 'Mark as read'], ['flag', 'Flag'], ['label', 'Apply label'], ['trash', 'Delete'], ['spam', 'Mark as spam'], ['forward', 'Forward to']];

export default function Rules() {
  const [rules, setRules] = useState([]);
  const [editing, setEditing] = useState(null);
  const load = () => api.get('/api/rules').then(setRules).catch(toastError);
  useEffect(() => { load(); }, []);
  return (
    <div className="settings-section">
      <div className="row"><div className="grow"><h2>Rules</h2><div className="muted">Automatically organise incoming mail. Rules using AI conditions run right after background analysis.</div></div>
        <button className="btn primary" onClick={() => setEditing({ name: '', enabled: true, matchAll: true, conditions: [{ field: 'from', op: 'contains', value: '' }], actions: [{ type: 'markRead' }], stop: false })}><Plus size={15} /> New rule</button></div>
      {rules.map((r) => (
        <div key={r.id} className="card item-card">
          <input type="checkbox" checked={r.enabled} onChange={async (e) => { await api.patch(`/api/rules/${r.id}`, { enabled: e.target.checked }); load(); }} />
          <div className="grow"><div style={{ fontWeight: 600 }}>{r.name || 'Untitled rule'}</div>
            <div className="small muted">If {r.conditions.map((c) => `${FIELDS.find((f) => f[0] === c.field)?.[1]} ${c.op.replace('_', ' ')} ${c.value ?? ''}`).join(r.matchAll ? ' and ' : ' or ')} → {r.actions.map((a) => ACTIONS.find((x) => x[0] === a.type)?.[1]).join(', ')}</div></div>
          <button className="icon-btn" title="Run on inbox now" onClick={async () => { const x = await api.post(`/api/rules/${r.id}/run`); toast(`Applied to ${x.matched} messages`); }}><Play size={16} /></button>
          <button className="icon-btn" onClick={() => setEditing(r)}><Pencil size={16} /></button>
          <button className="icon-btn" onClick={async () => { if (confirm('Delete rule?')) { await api.del(`/api/rules/${r.id}`); load(); } }}><Trash2 size={16} /></button>
        </div>
      ))}
      {!rules.length && <div className="card empty">No rules yet.</div>}
      {editing && <RuleEditor rule={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </div>
  );
}

function RuleEditor({ rule, onClose, onSaved }) {
  const [r, setR] = useState(structuredClone(rule));
  const folders = store.use((s) => s.folders);
  const labels = store.use((s) => s.labels);
  const accounts = store.use((s) => s.accounts);
  const setList = (k, i, patch) => setR((x) => ({ ...x, [k]: x[k].map((c, j) => (j === i ? { ...c, ...patch } : c)) }));
  const save = async () => { try { if (r.id) await api.patch(`/api/rules/${r.id}`, r); else await api.post('/api/rules', r); onSaved(); } catch (e) { toastError(e); } };
  return (
    <Modal title={r.id ? 'Edit rule' : 'New rule'} onClose={onClose} wide footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>Save</button></>}>
      <label className="field">Name<input className="input" value={r.name} onChange={(e) => setR({ ...r, name: e.target.value })} autoFocus /></label>
      <div className="row"><span>Apply to</span><select className="input" style={{ width: 'auto' }} value={r.accountId || ''} onChange={(e) => setR({ ...r, accountId: e.target.value ? Number(e.target.value) : null })}><option value="">all accounts</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.email}</option>)}</select>
        <span>when</span><select className="input" style={{ width: 'auto' }} value={r.matchAll ? 'all' : 'any'} onChange={(e) => setR({ ...r, matchAll: e.target.value === 'all' })}><option value="all">all</option><option value="any">any</option></select><span>conditions match:</span></div>
      {r.conditions.map((c, i) => (
        <div key={i} className="row">
          <select className="input" style={{ width: 170 }} value={c.field} onChange={(e) => setList('conditions', i, { field: e.target.value, op: OPS[kind(e.target.value)][0][0], value: kind(e.target.value) === 'bool' ? true : '' })}>{FIELDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          <select className="input" style={{ width: 150 }} value={c.op} onChange={(e) => setList('conditions', i, { op: e.target.value })}>{OPS[kind(c.field)].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          {kind(c.field) === 'bool' ? <select className="input" value={String(c.value)} onChange={(e) => setList('conditions', i, { value: e.target.value === 'true' })}><option value="true">yes</option><option value="false">no</option></select>
            : c.field === 'category' ? <select className="input" value={c.value} onChange={(e) => setList('conditions', i, { value: e.target.value })}><option value="" />{CATS.map((x) => <option key={x}>{x}</option>)}</select>
              : <input className="input" type={kind(c.field) === 'num' ? 'number' : 'text'} value={c.value} onChange={(e) => setList('conditions', i, { value: e.target.value })} />}
          <button className="icon-btn" onClick={() => setR({ ...r, conditions: r.conditions.filter((_, j) => j !== i) })}><X size={15} /></button>
        </div>
      ))}
      <button className="btn sm ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setR({ ...r, conditions: [...r.conditions, { field: 'subject', op: 'contains', value: '' }] })}><Plus size={13} /> Add condition</button>
      <div style={{ fontWeight: 600 }}>Then:</div>
      {r.actions.map((a, i) => (
        <div key={i} className="row">
          <select className="input" style={{ width: 200 }} value={a.type} onChange={(e) => setList('actions', i, { type: e.target.value })}>{ACTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          {a.type === 'move' && <select className="input" value={a.folderId || ''} onChange={(e) => setList('actions', i, { folderId: Number(e.target.value) })}><option value="">Choose folder…</option>{folders.accounts.map((acc) => <optgroup key={acc.accountId} label={acc.email}>{acc.folders.map((f) => <option key={f.id} value={f.id}>{f.path}</option>)}</optgroup>)}</select>}
          {a.type === 'label' && <select className="input" value={a.labelId || ''} onChange={(e) => setList('actions', i, { labelId: Number(e.target.value) })}><option value="">Choose label…</option>{labels.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>}
          {a.type === 'forward' && <input className="input" placeholder="email@example.com" value={a.to || ''} onChange={(e) => setList('actions', i, { to: e.target.value })} />}
          <span className="grow" />
          <button className="icon-btn" onClick={() => setR({ ...r, actions: r.actions.filter((_, j) => j !== i) })}><X size={15} /></button>
        </div>
      ))}
      <button className="btn sm ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setR({ ...r, actions: [...r.actions, { type: 'markRead' }] })}><Plus size={13} /> Add action</button>
      {r.conditions.some((c) => AI_FIELDS.includes(c.field)) && r.actions.some((a) => GATED.includes(a.type) || a.type === 'move') && <div className="notice warn" style={{ margin: 0 }}>This rule depends on AI judgement, so deleting, marking as spam, forwarding and moving to Trash/Junk will each ask for your approval instead of happening automatically.</div>}
      <Switch label="Stop processing more rules" checked={r.stop} onChange={(v) => setR({ ...r, stop: v })} />
    </Modal>
  );
}

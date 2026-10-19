import { useState } from 'react';
import { api } from './api.js';

export default function Login({ needsSetup, allowSignup, onDone }) {
  const [mode, setMode] = useState(needsSetup ? 'setup' : 'login');
  const [f, setF] = useState({ email: '', name: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setError('');
    try { await api.post(`/api/auth/${mode}`, f); onDone(); } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return (
    <div className="login">
      <form className="card" onSubmit={submit}>
        <div className="row"><img src="./icon.svg" width="40" alt="" /><div><div style={{ fontSize: 20, fontWeight: 700 }}>Halcyon</div><div className="small muted">Mail · Calendar · Contacts · AI</div></div></div>
        {mode === 'setup' && <div className="small muted">Welcome! Create the administrator account for this server.</div>}
        {mode !== 'login' && <label className="field">Name<input className="input" value={f.name} onChange={set('name')} autoComplete="name" /></label>}
        <label className="field">Email<input className="input" type="email" required value={f.email} onChange={set('email')} autoComplete="username" autoFocus /></label>
        <label className="field">Password<input className="input" type="password" required minLength={mode === 'login' ? 1 : 8} value={f.password} onChange={set('password')} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} /></label>
        {error && <div className="error-text small">{error}</div>}
        <button className="btn primary" disabled={busy} style={{ justifyContent: 'center', height: 38 }}>{mode === 'login' ? 'Sign in' : 'Create account'}</button>
        {allowSignup && mode !== 'setup' && <button type="button" className="btn ghost" onClick={() => setMode(mode === 'login' ? 'signup' : 'login')}>{mode === 'login' ? 'Create an account' : 'I already have an account'}</button>}
      </form>
    </div>
  );
}

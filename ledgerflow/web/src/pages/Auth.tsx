import { useState } from 'react';
import { post } from '../api';
import { Field, useAction } from '../ui';

export function Auth({ status, onDone }: { status: any; onDone: () => void }) {
  const [mode, setMode] = useState<'login' | 'register'>(status.needs_setup ? 'register' : 'login');
  const [f, setF] = useState({ name: '', email: '', password: '' }); const { busy, error, run } = useAction();
  const submit = (e: React.FormEvent) => { e.preventDefault(); run(async () => { await post(mode === 'login' ? '/api/auth/login' : '/api/auth/register', f); onDone(); }); };
  return <div className="login"><h1 style={{ color: 'var(--accent)', marginBottom: 6 }}>LedgerFlow</h1>
    <p className="muted">{status.needs_setup ? 'Welcome. Create the owner account to get started.' : 'Sign in to your workspace.'}</p>
    <form className="card form" onSubmit={submit}>
      {mode === 'register' && <Field label="Your name"><input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoComplete="name" /></Field>}
      <Field label="Email"><input required type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} autoComplete="username" /></Field>
      <Field label="Password" help={mode === 'register' ? 'At least 10 characters.' : undefined}><input required type="password" minLength={mode === 'register' ? 10 : 1} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} /></Field>
      {error && <div className="alert bad" role="alert">{error}</div>}
      <button className="btn primary" disabled={busy}>{busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}</button>
      {!status.needs_setup && status.registration_open && <button type="button" className="btn ghost" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>{mode === 'login' ? 'Create an account' : 'I already have an account'}</button>}
    </form></div>;
}

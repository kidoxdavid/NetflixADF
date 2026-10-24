import { useState } from 'react';
import { post } from '../api';
import { Field, useAction } from '../ui';

export function Onboarding({ onDone, onCancel }: { onDone: () => void; onCancel?: () => void }) {
  const [f, setF] = useState<any>({ legal_name: '', trading_name: '', email: '', phone: '', address: '', currency: 'CAD', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Toronto', tax_registration_label: '', tax_registration_number: '' });
  const { busy, error, run } = useAction(); const s = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  return <div className="login" style={{ maxWidth: 640 }}><h1>Set up your business</h1><p className="muted">You can change everything later in Settings. Tax registration is optional — leave it blank if you are not registered.</p>
    <form className="card form cols" onSubmit={(e) => { e.preventDefault(); run(async () => { await post('/api/businesses', f); onDone(); }); }}>
      <Field label="Legal business name" span><input required value={f.legal_name} onChange={s('legal_name')} /></Field>
      <Field label="Trading name (shown on documents)"><input value={f.trading_name} onChange={s('trading_name')} /></Field>
      <Field label="Default currency"><input value={f.currency} maxLength={3} onChange={(e) => setF({ ...f, currency: e.target.value.toUpperCase() })} /></Field>
      <Field label="Email"><input type="email" value={f.email} onChange={s('email')} /></Field><Field label="Phone"><input value={f.phone} onChange={s('phone')} /></Field>
      <Field label="Address" span><textarea value={f.address} onChange={s('address')} /></Field>
      <Field label="Tax registration label (optional)" help="e.g. GST/HST no."><input value={f.tax_registration_label} onChange={s('tax_registration_label')} /></Field><Field label="Tax registration number (optional)"><input value={f.tax_registration_number} onChange={s('tax_registration_number')} /></Field>
      <Field label="Time zone"><input value={f.timezone} onChange={s('timezone')} /></Field>
      {error && <div className="alert bad span" role="alert">{error}</div>}
      <button className="btn primary span" disabled={busy}>Create workspace</button>{onCancel && <button type="button" className="btn span" onClick={onCancel}>Cancel</button>}</form></div>;
}

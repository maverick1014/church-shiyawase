'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { BrandLogo } from '@/components/BrandLogo';
import { Field, PasswordInput } from '@/components/ui';
import { useChurchProfile } from '@/lib/church';
import { useT } from '@/lib/i18n';

export default function LoginPage() {
  const router = useRouter();
  // No session exists yet, so there is no account language to honour: the
  // login screen always renders in the app default (English) via the i18n
  // context's default value.
  //
  // The church's NAME is the exception, and it is not a language question at
  // all: it is data on the church record, the same in all three languages, so
  // it is fetched from the public `GET /api/church` rather than translated.
  const t = useT();
  const church = useChurchProfile();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.message ?? t('login.failed'));
      }
      router.push('/');
      router.refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        background: 'var(--paper)',
        padding: 20,
      }}
    >
      <form
        onSubmit={submit}
        className="card"
        style={{ width: '100%', maxWidth: 380, padding: 26 }}
      >
        <div className="flex items-center gap-10" style={{ marginBottom: 6 }}>
          <span
            style={{ width: 40, height: 40, borderRadius: 11, background: '#fff', display: 'grid', placeItems: 'center', flexShrink: 0, overflow: 'hidden', boxShadow: '0 1px 2px rgba(0,0,0,.12), inset 0 0 0 1px rgba(0,0,0,.05)' }}
          >
            <BrandLogo size={34} church={church} />
          </span>
          <div className="serif" style={{ fontSize: 19, fontWeight: 600 }}>
            {church?.name ?? t('church.defaultName')}
            <div className="muted" style={{ fontSize: 11, fontWeight: 500, letterSpacing: 1 }}>
              {t('login.subtitle')}
            </div>
          </div>
        </div>
        <h2 className="serif" style={{ fontSize: 18, margin: '14px 0 4px' }}>{t('login.submit')}</h2>
        <p className="muted" style={{ fontSize: 12.5, margin: '0 0 16px' }}>
          {t('login.hint')}
        </p>

        {err && <div className="error-banner">⚠️ {err}</div>}

        <Field label={t('login.email')}>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@grace.org"
            autoComplete="username"
            required
          />
        </Field>
        <Field label={t('login.password')}>
          <PasswordInput
            value={password}
            onChange={setPassword}
            placeholder="••••••••"
            autoComplete="current-password"
            required
          />
        </Field>
        <button className="btn block" type="submit" disabled={busy} style={{ marginTop: 6 }}>
          {busy ? t('login.submitting') : t('login.submit')}
        </button>
      </form>
    </div>
  );
}

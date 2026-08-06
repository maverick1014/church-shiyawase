'use client';

import { useParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { BrandLogo } from '@/components/BrandLogo';
import { Field } from '@/components/ui';
import { useT } from '@/lib/i18n';

interface FormPair {
  id: string;
  form_token: string;
  mentor?: { full_name: string };
  trainee?: { full_name: string };
  program?: { name: string; total_days: number };
  progress: { day_number: number; completed: boolean }[];
}

export default function DailyFormPage() {
  const { token } = useParams<{ token: string }>();
  // Public link — no session, so this renders in the app default language.
  const t = useT();
  const [pair, setPair] = useState<FormPair | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<'form' | 'done'>('form');

  const [day, setDay] = useState<number>(1);
  const [completed, setCompleted] = useState(true);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const load = () => {
    setLoading(true);
    api
      .get<FormPair>(`/discipleship/form/${token}`)
      .then((p) => {
        setPair(p);
        setError(null);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(load, [token]);

  const total = pair?.program?.total_days ?? 40;
  const doneDays = useMemo(
    () => new Set((pair?.progress ?? []).filter((r) => r.completed).map((r) => r.day_number)),
    [pair],
  );
  const done = doneDays.size;
  const pct = Math.round((done / total) * 100);

  useEffect(() => {
    // Default the day selector to the next unfilled day.
    if (pair) {
      const next = Math.min(total, done + 1);
      setDay(next);
    }
  }, [pair, done, total]);

  const submit = async () => {
    setSaving(true);
    try {
      await api.post(`/discipleship/form/${token}/progress`, {
        day_number: day,
        completed,
        notes: notes || undefined,
      });
      setStep('done');
      setNotes('');
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'var(--paper)', overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
      <div className="flex-between" style={{ padding: '15px 20px', borderBottom: '1px solid var(--border)', background: 'var(--surface)', position: 'sticky', top: 0, zIndex: 2 }}>
        <div className="flex items-center gap-10 serif" style={{ fontWeight: 600, fontSize: 15 }}>
          <span style={{ width: 30, height: 30, borderRadius: 8, background: '#fff', display: 'grid', placeItems: 'center', flexShrink: 0, overflow: 'hidden', boxShadow: 'inset 0 0 0 1px rgba(0,0,0,.06)' }}>
            <BrandLogo size={26} />
          </span>
          {t('form.header')}
        </div>
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '26px 18px 44px' }}>
        <div className="card" style={{ width: '100%', maxWidth: 460 }}>
          {loading ? (
            <div className="loading">{t('common.loading')}</div>
          ) : error ? (
            <div className="error-banner">⚠️ {error}</div>
          ) : step === 'done' ? (
            <div style={{ textAlign: 'center', padding: '20px 6px' }}>
              <div style={{ width: 62, height: 62, borderRadius: '50%', background: 'var(--good-soft)', color: 'var(--good)', display: 'grid', placeItems: 'center', fontSize: 30, margin: '0 auto 14px' }}>✓</div>
              <h3 className="serif" style={{ margin: '0 0 6px', fontSize: 18 }}>{t('form.doneTitle')}</h3>
              <p className="muted" style={{ margin: '0 0 16px', fontSize: 13 }}>
                {t('form.doneBody', { name: pair?.trainee?.full_name ?? '' })}
              </p>
              <button className="btn ghost" onClick={() => setStep('form')}>{t('form.again')}</button>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-10 flex-wrap" style={{ marginBottom: 4 }}>
                <span className="badge b-brand">{t('disc.col.mentor')}</span>
                <strong>{pair?.mentor?.full_name}</strong>
                <span style={{ color: 'var(--accent)', fontWeight: 700 }}>➜</span>
                <span className="badge b-accent">{t('disc.col.trainee')}</span>
                <strong>{pair?.trainee?.full_name}</strong>
              </div>
              <div className="muted" style={{ fontSize: 12.5 }}>
                {t('form.progressSummary', { done, total })}
              </div>
              <div className="progress-row mt-14">
                <div className="bar"><span style={{ width: `${pct}%` }} /></div>
                <span className="pct">{pct}%</span>
              </div>

              <div className="day-grid" style={{ gridTemplateColumns: 'repeat(10,1fr)', gap: 5, margin: '12px 0 4px' }}>
                {Array.from({ length: total }, (_, i) => (
                  <div key={i} className={`day-cell ${doneDays.has(i + 1) ? 'done' : ''} ${i + 1 === day ? 'today' : ''}`}>{i + 1}</div>
                ))}
              </div>

              <div className="muted" style={{ fontSize: 14, fontWeight: 600, margin: '16px 0 10px' }}>{t('form.todayEntry')}</div>
              <Field label={t('form.dayLabel')}>
                <select value={day} onChange={(e) => setDay(Number(e.target.value))}>
                  {Array.from({ length: total }, (_, i) => (
                    <option key={i} value={i + 1}>
                      {t('form.day', { n: i + 1 })}{doneDays.has(i + 1) ? ' ✓' : ''}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('form.completedLabel')}>
                <div className="seg block">
                  <button className={completed ? 'on-good' : ''} onClick={() => setCompleted(true)}>
                    {t('disc.progress.completed')}
                  </button>
                  <button className={!completed ? 'on-crit' : ''} onClick={() => setCompleted(false)}>
                    {t('form.notCompleted')}
                  </button>
                </div>
              </Field>
              <Field label={t('form.notes')}>
                <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t('form.notesPlaceholder')} />
              </Field>
              <button className="btn accent block" onClick={submit} disabled={saving}>
                {saving ? t('form.submitting') : t('form.submitToday')}
              </button>
            </>
          )}
        </div>
        <div className="faint" style={{ marginTop: 18, fontSize: 12, textAlign: 'center', maxWidth: 460 }}>
          {t('form.privacy')}
        </div>
      </div>
    </div>
  );
}

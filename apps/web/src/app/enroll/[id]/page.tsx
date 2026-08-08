'use client';

import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { BrandLogo } from '@/components/BrandLogo';
import { Field } from '@/components/ui';
import { useChurchProfile } from '@/lib/church';
import { trainingCategoryLabel } from '@/lib/labels';
import { useT } from '@/lib/i18n';
import type { MessageKey } from '@/lib/i18n';

interface EnrollTraining {
  id: string;
  name: string;
  category: string | null;
  is_enrollable: boolean;
  total_sessions: number;
}

type EnrollStatus = 'ok' | 'already' | 'no_member' | 'ambiguous' | 'closed';

// Friendly copy per outcome. `no_member` / `ambiguous` deliberately steer the
// visitor to the pastor rather than creating a member (avoids duplicates).
const RESULT: Record<
  EnrollStatus,
  { icon: string; tone: string; title: MessageKey; body: MessageKey }
> = {
  ok: { icon: '✓', tone: 'var(--good)', title: 'enroll.okTitle', body: 'enroll.ok' },
  already: { icon: 'ℹ', tone: 'var(--brand)', title: 'enroll.alreadyTitle', body: 'enroll.already' },
  no_member: { icon: '!', tone: 'var(--crit)', title: 'enroll.noMemberTitle', body: 'enroll.noMember' },
  ambiguous: { icon: '!', tone: 'var(--crit)', title: 'enroll.ambiguousTitle', body: 'enroll.ambiguous' },
  closed: { icon: '!', tone: 'var(--crit)', title: 'enroll.closedTitle', body: 'enroll.closed' },
};

export default function EnrollFormPage() {
  const { id } = useParams<{ id: string }>();
  // Public link — no session, so this renders in the app default language.
  // The church's name is data, not a translation: it comes off the record.
  const t = useT();
  const church = useChurchProfile();
  const [training, setTraining] = useState<EnrollTraining | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [fullName, setFullName] = useState('');
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ status: EnrollStatus; name: string } | null>(null);

  useEffect(() => {
    setLoading(true);
    api
      .get<EnrollTraining>(`/trainings/enroll/${id}`)
      .then((t) => {
        setTraining(t);
        setError(null);
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [id]);

  const submit = async () => {
    if (!fullName.trim()) return;
    setSaving(true);
    try {
      const r = await api.post<{ status: EnrollStatus; name?: string }>(`/trainings/enroll/${id}`, {
        full_name: fullName.trim(),
      });
      setResult({ status: r.status, name: r.name ?? fullName.trim() });
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
            <BrandLogo size={26} church={church} />
          </span>
          {t('enroll.header')}
        </div>
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '26px 18px 44px' }}>
        <div className="card" style={{ width: '100%', maxWidth: 460 }}>
          {loading ? (
            <div className="loading">{t('common.loading')}</div>
          ) : error ? (
            <div className="error-banner">⚠️ {error}</div>
          ) : result ? (
            <div style={{ textAlign: 'center', padding: '20px 6px' }}>
              <div style={{ width: 62, height: 62, borderRadius: '50%', background: 'var(--surface-2)', color: RESULT[result.status].tone, display: 'grid', placeItems: 'center', fontSize: 30, margin: '0 auto 14px' }}>
                {RESULT[result.status].icon}
              </div>
              <h3 className="serif" style={{ margin: '0 0 6px', fontSize: 18 }}>{t(RESULT[result.status].title)}</h3>
              <p className="muted" style={{ margin: '0 0 16px', fontSize: 13, lineHeight: 1.7 }}>
                {t(RESULT[result.status].body, { name: result.name })}
              </p>
              {(result.status === 'no_member' || result.status === 'ambiguous') && (
                <button className="btn ghost" onClick={() => { setResult(null); setFullName(''); }}>
                  {t('enroll.retry')}
                </button>
              )}
            </div>
          ) : (
            <>
              <div className="flex items-center gap-8 flex-wrap" style={{ marginBottom: 4 }}>
                {training?.category && (
                  <span className="badge b-accent">{trainingCategoryLabel(training.category, t)}</span>
                )}
                <strong className="serif" style={{ fontSize: 17 }}>{training?.name}</strong>
              </div>
              <div className="muted" style={{ fontSize: 12.5, marginBottom: 4 }}>
                {t('enroll.sessionsLine', { n: training?.total_sessions ?? 0 })}
              </div>

              {training && !training.is_enrollable ? (
                <div className="hint" style={{ marginTop: 14 }}>⚠️ {t('enroll.closed')}</div>
              ) : (
                <>
                  <div style={{ marginTop: 16 }}>
                    <Field label={t('enroll.nameLabel')}>
                      <input
                        value={fullName}
                        onChange={(e) => setFullName(e.target.value)}
                        placeholder={t('enroll.namePlaceholderExample')}
                        autoFocus
                      />
                    </Field>
                  </div>
                  <div className="hint" style={{ marginBottom: 14 }}>{t('enroll.hint')}</div>
                  <button className="btn accent block" onClick={submit} disabled={saving || !fullName.trim()}>
                    {saving ? t('enroll.submitting') : t('enroll.submit')}
                  </button>
                </>
              )}
            </>
          )}
        </div>
        <div className="faint" style={{ marginTop: 18, fontSize: 12, textAlign: 'center', maxWidth: 460 }}>
          {church?.name ?? ''}
        </div>
      </div>
    </div>
  );
}

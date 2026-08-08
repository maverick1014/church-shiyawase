'use client';

import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { BrandLogo } from '@/components/BrandLogo';
import { Field } from '@/components/ui';
import { useChurchProfile } from '@/lib/church';
import { formatMoney, hasFee, trainingKindKey, trainingMeta } from '@/lib/labels';
import { useT } from '@/lib/i18n';
import type { MessageKey } from '@/lib/i18n';
import { TrainingKind } from '@tog/shared';

/**
 * What the public endpoint hands back — the fields a visitor needs to decide
 * and to pay, and nothing else (the endpoint answers with no session at all).
 *
 * `kind` and the date/time/place ride along so an ACTIVITY reads as one
 * ("On 2026-09-12 09:00 at the church car park") instead of claiming to have
 * "1 sessions"; `pic` / `pic_contact` because people ring before they sign up;
 * and the 报名费 block because nobody can pay what the page does not say.
 */
interface EnrollTraining {
  id: string;
  name: string;
  kind: TrainingKind;
  is_enrollable: boolean;
  total_sessions: number;
  starts_on: string | null;
  ends_on: string | null;
  start_time: string | null;
  location: string | null;
  pic: string | null;
  pic_contact: string | null;
  fee: string | number | null;
  payment_instructions: string | null;
  payment_qr_url: string | null;
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
  const [slip, setSlip] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ status: EnrollStatus; name: string } | null>(null);

  useEffect(() => {
    setLoading(true);
    api
      .get<EnrollTraining>(`/trainings/enroll/${id}`)
      .then((t2) => {
        setTraining(t2);
        setError(null);
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [id]);

  // A fee makes the receipt part of the sign-up, not an afterthought — the
  // server refuses an enrolment without one, so the button waits for it too.
  const paid = hasFee(training?.fee);

  const submit = async () => {
    if (!fullName.trim()) return;
    if (paid && !slip) {
      setError(t('enroll.slipRequired'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      let r: { status: EnrollStatus; name?: string };
      if (paid && slip) {
        // The receipt travels WITH the sign-up rather than through an upload
        // endpoint of its own: nothing is stored until the name has matched a
        // member, so this public path can never be used as file storage.
        const form = new FormData();
        form.append('full_name', fullName.trim());
        form.append('slip', slip);
        // `api.upload` posts a FormData body without a JSON content-type, which
        // is exactly what this needs (rule G4 — one client, one mechanism).
        r = await api.upload<{ status: EnrollStatus; name?: string }>(
          `/trainings/enroll/${id}`,
          form,
        );
      } else {
        r = await api.post<{ status: EnrollStatus; name?: string }>(`/trainings/enroll/${id}`, {
          full_name: fullName.trim(),
        });
      }
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
          ) : error && !training ? (
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
                {training?.kind && (
                  <span className="badge b-brand">{t(trainingKindKey(training.kind))}</span>
                )}
                {paid && training && (
                  <span className="badge b-accent">
                    {t('trainings.fee', { amount: formatMoney(training.fee) })}
                  </span>
                )}
                <strong className="serif" style={{ fontSize: 17 }}>{training?.name}</strong>
              </div>
              {/* Who to ring, and when / where — the same line the admin pages
                  show, built once in lib/labels.ts (rule G4). The contact is
                  here on purpose: people ask about the detail before they
                  commit, and the PIC is who they ask. */}
              <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.8, marginBottom: 4 }}>
                {training ? trainingMeta(training, t).join(' · ') : ''}
              </div>
              <div className="faint" style={{ fontSize: 12, marginBottom: 4 }}>{t('enroll.reviewLine')}</div>

              {training && !training.is_enrollable ? (
                <div className="hint" style={{ marginTop: 14 }}>⚠️ {t('enroll.closed')}</div>
              ) : (
                <>
                  {/* 报名费 — the amount, how to pay it and the QR, ABOVE the
                      receipt field, because nobody can attach a receipt for a
                      payment the page never explained. */}
                  {paid && training && (
                    <div style={{ marginTop: 16, padding: '14px 15px', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 10 }}>
                      <strong style={{ fontSize: 13.5 }}>
                        {t('enroll.feeTitle', { amount: formatMoney(training.fee) })}
                      </strong>
                      {training.payment_instructions && (
                        <>
                          <div className="faint" style={{ fontSize: 11.5, margin: '10px 0 3px', fontWeight: 600 }}>
                            {t('enroll.payHow')}
                          </div>
                          <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.8, whiteSpace: 'pre-wrap' }}>
                            {training.payment_instructions}
                          </div>
                        </>
                      )}
                      {training.payment_qr_url && (
                        <div style={{ marginTop: 12, textAlign: 'center' }}>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={training.payment_qr_url}
                            alt={t('enroll.qrAlt')}
                            style={{ width: 180, maxWidth: '100%', borderRadius: 10, border: '1px solid var(--border)', background: '#fff' }}
                          />
                          <div className="faint" style={{ fontSize: 11.5, marginTop: 6 }}>{t('enroll.qrHint')}</div>
                        </div>
                      )}
                    </div>
                  )}

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

                  {paid && (
                    <>
                      {/* Pay first, then attach the receipt, and know that a
                          person checks it before the place is confirmed. */}
                      <div className="hint" style={{ marginBottom: 12 }}>{t('enroll.slipGuide')}</div>
                      <Field label={t('enroll.slipLabel')}>
                        <input
                          type="file"
                          accept="image/*,application/pdf"
                          onChange={(e) => setSlip(e.target.files?.[0] ?? null)}
                          aria-label={t('enroll.slipPick')}
                        />
                      </Field>
                      <div className="faint" style={{ fontSize: 11.5, marginBottom: 12 }}>
                        {slip ? t('enroll.slipChosen', { name: slip.name }) : t('enroll.slipTypes')}
                      </div>
                    </>
                  )}

                  {error && <div className="error-banner" style={{ marginBottom: 12 }}>⚠️ {error}</div>}
                  <div className="hint" style={{ marginBottom: 14 }}>{t('enroll.hint')}</div>
                  <button
                    className="btn accent block"
                    onClick={submit}
                    disabled={saving || !fullName.trim() || (paid && !slip)}
                  >
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

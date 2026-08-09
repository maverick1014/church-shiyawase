'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { BrandLogo } from '@/components/BrandLogo';
import { Field, PhotoPicker } from '@/components/ui';
import { useChurchProfile } from '@/lib/church';
import { GENDER_OPTIONS, genderKey } from '@/lib/labels';
import { useT } from '@/lib/i18n';
import type { MessageKey } from '@/lib/i18n';
import type { HallRow } from '@/lib/types';
import { Gender } from '@tog/shared';

/**
 * `/join` — the public member self-registration form.
 *
 * The church hands out one link and people fill in their own details, instead
 * of somebody typing them off a paper slip. Same shape as the other two
 * shell-less public pages (`/enroll/[id]`, `/d/[token]`): no session, no nav,
 * the church's own logo and name off `useChurchProfile`, and the app's default
 * language because there is no account to read a language preference from.
 *
 * What a visitor may set is deliberately small — their own contact details and
 * a photo. A church role, a life group, a status: those are the church's to
 * decide afterwards, and `POST /api/members/register` does not read them from
 * the body at all.
 */

/** The bootstrap the form needs, and the only thing this path hands out. */
type RegisterOptions = { halls: HallRow[] };

type RegisterStatus = 'created' | 'updated';

// The two outcomes read differently on purpose: somebody already on the roll
// should be told their details were updated, not welcomed as a stranger.
const RESULT: Record<RegisterStatus, { icon: string; tone: string; title: MessageKey; body: MessageKey }> = {
  created: { icon: '✓', tone: 'var(--good)', title: 'join.createdTitle', body: 'join.created' },
  updated: { icon: 'ℹ', tone: 'var(--brand)', title: 'join.updatedTitle', body: 'join.updated' },
};

export default function JoinPage() {
  const t = useT();
  const church = useChurchProfile();
  const [halls, setHalls] = useState<HallRow[]>([]);
  const [form, setForm] = useState({
    full_name: '',
    english_name: '',
    phone: '',
    email: '',
    gender: '' as Gender | '',
    date_of_birth: '',
    address: '',
    hall_id: '',
  });
  const [photo, setPhoto] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ status: RegisterStatus; name: string } | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .get<RegisterOptions>('/members/register')
      .then((o) => alive && setHalls(o.halls))
      // A congregation list that cannot be read is not worth blocking the form
      // for: a church with one congregation needs no choice at all, and the
      // server refuses a registration that genuinely needs one.
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // One congregation is not a question worth asking; several is.
  const hallId = form.hall_id || (halls.length === 1 ? halls[0].id : '');

  const submit = async () => {
    const name = form.full_name.trim();
    if (!name) {
      setError(t('join.err.name'));
      return;
    }
    if (!hallId && halls.length > 1) {
      setError(t('join.err.hall'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const fields: Record<string, string> = {
        full_name: name,
        english_name: form.english_name.trim(),
        phone: form.phone.trim(),
        email: form.email.trim(),
        gender: form.gender,
        date_of_birth: form.date_of_birth,
        address: form.address.trim(),
        hall_id: hallId,
      };
      let r: { status: RegisterStatus };
      if (photo) {
        // The photo travels WITH the registration in one multipart POST rather
        // than through an upload endpoint of its own — the same rule the paid
        // sign-up's receipt follows: nothing reaches storage until the row has
        // been accepted, so this public path cannot be used as file storage.
        const body = new FormData();
        for (const [key, value] of Object.entries(fields)) body.append(key, value);
        body.append('photo', photo);
        r = await api.upload<{ status: RegisterStatus }>('/members/register', body);
      } else {
        r = await api.post<{ status: RegisterStatus }>('/members/register', fields);
      }
      setResult({ status: r.status, name });
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
          {t('join.header')}
        </div>
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '26px 18px 44px' }}>
        <div className="card" style={{ width: '100%', maxWidth: 460 }}>
          {result ? (
            <div style={{ textAlign: 'center', padding: '20px 6px' }}>
              <div style={{ width: 62, height: 62, borderRadius: '50%', background: 'var(--surface-2)', color: RESULT[result.status].tone, display: 'grid', placeItems: 'center', fontSize: 30, margin: '0 auto 14px' }}>
                {RESULT[result.status].icon}
              </div>
              <h3 className="serif" style={{ margin: '0 0 6px', fontSize: 18 }}>{t(RESULT[result.status].title)}</h3>
              <p className="muted" style={{ margin: '0 0 16px', fontSize: 13, lineHeight: 1.7 }}>
                {t(RESULT[result.status].body, { name: result.name })}
              </p>
              <button
                className="btn ghost"
                onClick={() => {
                  setResult(null);
                  setForm({ full_name: '', english_name: '', phone: '', email: '', gender: '', date_of_birth: '', address: '', hall_id: form.hall_id });
                  setPhoto(null);
                }}
              >
                {t('join.again')}
              </button>
            </div>
          ) : (
            <>
              <strong className="serif" style={{ fontSize: 17 }}>{t('join.title')}</strong>
              <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.8, margin: '4px 0 14px' }}>
                {t('join.intro')}
              </div>

              <div className="form-row">
                <Field label={t('join.field.name')}>
                  <input
                    value={form.full_name}
                    onChange={(e) => setForm({ ...form, full_name: e.target.value })}
                    placeholder={t('join.namePlaceholder')}
                    autoFocus
                  />
                </Field>
                <Field label={t('join.field.englishName')}>
                  <input
                    value={form.english_name}
                    onChange={(e) => setForm({ ...form, english_name: e.target.value })}
                    placeholder={t('join.englishPlaceholder')}
                  />
                </Field>
              </div>
              <div className="form-row">
                <Field label={t('join.field.phone')}>
                  <input
                    value={form.phone}
                    onChange={(e) => setForm({ ...form, phone: e.target.value })}
                    placeholder="012-000 0000"
                    inputMode="tel"
                  />
                </Field>
                <Field label={t('join.field.email')}>
                  <input
                    value={form.email}
                    onChange={(e) => setForm({ ...form, email: e.target.value })}
                    placeholder="name@grace.org"
                    inputMode="email"
                  />
                </Field>
              </div>
              <div className="form-row">
                <Field label={t('join.field.gender')}>
                  <select
                    value={form.gender}
                    onChange={(e) => setForm({ ...form, gender: e.target.value as Gender | '' })}
                  >
                    <option value="">{t('common.unset')}</option>
                    {GENDER_OPTIONS.map((g) => (
                      <option key={g} value={g}>{t(genderKey(g))}</option>
                    ))}
                  </select>
                </Field>
                <Field label={t('join.field.birthday')}>
                  <input
                    type="date"
                    className={form.date_of_birth ? undefined : 'date-empty'}
                    value={form.date_of_birth}
                    onChange={(e) => setForm({ ...form, date_of_birth: e.target.value })}
                  />
                </Field>
              </div>
              {/* Where the church would visit them or post something — theirs
                  to give, unlike 推荐人, which is the church's own record of how
                  somebody arrived and is not on this form at all. */}
              <Field label={t('join.field.address')}>
                <input
                  value={form.address}
                  onChange={(e) => setForm({ ...form, address: e.target.value })}
                />
              </Field>
              {/* Only asked when there is something to choose between: a church
                  with one congregation files everyone in it anyway. */}
              {halls.length > 1 && (
                <Field label={t('join.field.hall')}>
                  <select value={hallId} onChange={(e) => setForm({ ...form, hall_id: e.target.value })}>
                    <option value="">{t('hall.choose')}</option>
                    {halls.map((h) => (
                      <option key={h.id} value={h.id}>{h.name}</option>
                    ))}
                  </select>
                </Field>
              )}
              <Field label={t('join.field.photo')}>
                <PhotoPicker file={photo} onChange={setPhoto} name={form.full_name} />
              </Field>
              <div className="faint" style={{ fontSize: 11.5, margin: '2px 0 12px' }}>{t('photo.hint')}</div>

              {error && <div className="error-banner" style={{ marginBottom: 12 }}>⚠️ {error}</div>}
              <div className="hint" style={{ marginBottom: 14 }}>{t('join.hint')}</div>
              <button className="btn accent block" onClick={submit} disabled={saving || !form.full_name.trim()}>
                {saving ? t('join.submitting') : t('join.submit')}
              </button>
            </>
          )}
        </div>
        <div className="faint" style={{ marginTop: 18, fontSize: 12, textAlign: 'center', maxWidth: 460 }}>
          {t('join.privacy', { church: church?.name ?? '' })}
        </div>
      </div>
    </div>
  );
}

'use client';

import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { BrandLogo } from '@/components/BrandLogo';
import { Combobox, Field, PhotoPicker, useMemberOptions, useUnsavedWarning } from '@/components/ui';
import { useChurchProfile } from '@/lib/church';
import { GENDER_OPTIONS, genderKey } from '@/lib/labels';
import type { ComboOption } from '@/lib/combobox';
import { useT } from '@/lib/i18n';
import type { MessageKey } from '@/lib/i18n';
import type { HallRow } from '@/lib/types';
import { Gender } from '@tog/shared';

/**
 * `/welcome` — the public FIRST-VISIT form (0031).
 *
 * The visitor half of `/join`, and a page of its own for the same reason
 * `/visitors` is: what the church hands a first-time guest at the door is not
 * the form it hands somebody joining. This one asks only what a stranger can
 * actually answer — their name, a way to reach them, and who brought them —
 * and never a life group, a ministry or a rank, which are what somebody takes
 * on once they belong.
 *
 * `POST /api/members/welcome` creates a 访客 because of WHICH handler it is,
 * never because of anything in the body; and it stamps 来访日期 itself, since
 * the person filling this in is visiting today. A returning face is matched
 * and UPDATED rather than duplicated (`matchRegistrant`), and an update never
 * touches the role — somebody who is already a member and fills this in on a
 * whim is not demoted by it.
 *
 * The fifth shell-less page: no session, no nav, the church's own logo and
 * name off `useChurchProfile`, and the app's default language because there
 * is no account to read a preference from.
 */

/** The bootstrap this path hands out — narrower than `/join`'s, because a
 *  first-time visitor has no use for the life-group list. `members` carries
 *  only names, the minimum a 推荐人 Combobox needs on a page nobody has
 *  signed into. */
type WelcomeOptions = {
  halls: HallRow[];
  members: { id: string; full_name: string; english_name: string | null }[];
};

type WelcomeStatus = 'created' | 'updated';

// The two outcomes read differently on purpose: somebody the church already
// knows should be told their details were updated, not welcomed as a stranger.
const RESULT: Record<WelcomeStatus, { icon: string; tone: string; title: MessageKey; body: MessageKey }> = {
  created: { icon: '✓', tone: 'var(--good)', title: 'welcome.createdTitle', body: 'welcome.created' },
  updated: { icon: 'ℹ', tone: 'var(--brand)', title: 'welcome.updatedTitle', body: 'welcome.updated' },
};

const EMPTY = {
  full_name: '',
  english_name: '',
  phone: '',
  email: '',
  gender: '' as Gender | '',
  date_of_birth: '',
  address: '',
  hall_id: '',
  referred_by: '',
  notes: '',
};

export default function WelcomePage() {
  const t = useT();
  const church = useChurchProfile();
  const [options, setOptions] = useState<WelcomeOptions>({ halls: [], members: [] });
  const [form, setForm] = useState(EMPTY);
  const [photo, setPhoto] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ status: WelcomeStatus; name: string } | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .get<WelcomeOptions>('/members/welcome')
      // A congregation list that cannot be read is not worth blocking the form
      // for: a church with one congregation needs no choice at all, and the
      // server refuses a registration that genuinely needs one.
      .then((o) => alive && setOptions(o))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const { halls, members } = options;
  // One congregation is not a question worth asking; several is.
  const hallId = form.hall_id || (halls.length === 1 ? halls[0].id : '');

  // Somebody standing at the door filling this in on a phone has no session
  // and no way to recover a half-typed form — a stray refresh is the whole
  // thing gone. Nothing to navigate away to on a shell-less page, so the
  // browser's own prompt is the entire guard (rule G4, same as /join).
  useUnsavedWarning(
    !result && (Object.values(form).some((v) => v !== '') || photo !== null),
  );

  // A member picker, never a `<select>` (rule G4) — 无推荐人 first, over the
  // narrower (names-only) list this public page is handed. No session, so no
  // congregation to read a naming preference from: `useMemberOptions` falls
  // back to the Chinese name, the documented fallback wherever the hall is
  // unknown (0028).
  const memberOptions = useMemberOptions();
  const referrerOpts: ComboOption[] = useMemo(
    () => memberOptions(members, { lead: { value: '', label: t('members.noReferrer') } }),
    [members, memberOptions, t],
  );

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
        referred_by: form.referred_by,
        notes: form.notes.trim(),
      };
      let r: { status: WelcomeStatus };
      if (photo) {
        // The photo travels WITH the form in one multipart POST rather than
        // through an upload endpoint of its own — nothing reaches storage
        // until the row has been accepted, so this public path cannot be used
        // as anonymous file storage.
        const body = new FormData();
        for (const [key, value] of Object.entries(fields)) body.append(key, value);
        body.append('photo', photo);
        r = await api.upload<{ status: WelcomeStatus }>('/members/welcome', body);
      } else {
        r = await api.post<{ status: WelcomeStatus }>('/members/welcome', fields);
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
          {t('welcome.header')}
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
              {/* The congregation is kept: a table of guests filling this in
                  one after another is all in the same one. */}
              <button
                className="btn ghost"
                onClick={() => {
                  setResult(null);
                  setForm({ ...EMPTY, hall_id: form.hall_id });
                  setPhoto(null);
                }}
              >
                {t('join.again')}
              </button>
            </div>
          ) : (
            <>
              <strong className="serif" style={{ fontSize: 17 }}>{t('welcome.title')}</strong>
              <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.8, margin: '4px 0 14px' }}>
                {t('welcome.intro')}
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
              <div className="form-row">
                <Field label={t('join.field.address')}>
                  <input
                    value={form.address}
                    onChange={(e) => setForm({ ...form, address: e.target.value })}
                  />
                </Field>
                {/* Who brought them — the single most useful thing on this
                    form, since it is how the church knows who to thank and who
                    will follow up. */}
                <Field label={t('welcome.field.broughtBy')}>
                  <Combobox
                    value={form.referred_by}
                    onChange={(id) => setForm({ ...form, referred_by: id })}
                    options={referrerOpts}
                    ariaLabel={t('welcome.field.broughtBy')}
                  />
                </Field>
              </div>
              {/* Only asked when there is something to choose between: a
                  church with one congregation files everyone in it anyway. */}
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
              <Field label={t('member.field.notes')}>
                <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} />
              </Field>
              <Field label={t('join.field.photo')}>
                <PhotoPicker file={photo} onChange={setPhoto} name={form.full_name} />
              </Field>
              <div className="faint" style={{ fontSize: 11.5, margin: '2px 0 12px' }}>{t('photo.hint')}</div>

              {error && <div className="error-banner" style={{ marginBottom: 12 }}>⚠️ {error}</div>}
              <div className="hint" style={{ marginBottom: 14 }}>{t('welcome.hint')}</div>
              <button className="btn accent block" onClick={submit} disabled={saving || !form.full_name.trim()}>
                {saving ? t('join.submitting') : t('welcome.submit')}
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

'use client';

import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { BrandLogo } from '@/components/BrandLogo';
import { Combobox, Field, PhotoPicker, TagsInput } from '@/components/ui';
import { useChurchProfile } from '@/lib/church';
import { GENDER_OPTIONS, genderKey } from '@/lib/labels';
import type { ComboOption } from '@/lib/combobox';
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
 * The field set mirrors the staff-facing add-member form (church feedback:
 * "all field is needed") — everything except a church RANK and a group SEAT,
 * which stay the church's own calls: `POST /api/members/register` reads
 * `church_role`/`group_position` from nowhere at all, so a body carrying
 * either is silently ignored, never obeyed.
 */

/** The bootstrap the form needs, and the only thing this path hands out.
 *  `members` carries only names (never phone/email/address/birthday) — the
 *  minimum a 推荐人 Combobox needs and no more, on a page nobody has signed
 *  into. */
type RegisterOptions = {
  halls: HallRow[];
  groups: { id: string; name: string; hall_id: string }[];
  members: { id: string; full_name: string; english_name: string | null }[];
};

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
  const [options, setOptions] = useState<RegisterOptions>({ halls: [], groups: [], members: [] });
  const [form, setForm] = useState({
    full_name: '',
    english_name: '',
    phone: '',
    email: '',
    gender: '' as Gender | '',
    date_of_birth: '',
    address: '',
    hall_id: '',
    // '' = 无推荐人 — the same convention the staff-facing form stores (nobody
    // referred them is the ordinary case, not a gap somebody forgot).
    referred_by: '',
    group_id: '',
    notes: '',
  });
  const [serving, setServing] = useState<string[]>([]);
  const [photo, setPhoto] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ status: RegisterStatus; name: string } | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .get<RegisterOptions>('/members/register')
      .then((o) => alive && setOptions(o))
      // A congregation list that cannot be read is not worth blocking the form
      // for: a church with one congregation needs no choice at all, and the
      // server refuses a registration that genuinely needs one.
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const { halls, groups, members } = options;
  // One congregation is not a question worth asking; several is.
  const hallId = form.hall_id || (halls.length === 1 ? halls[0].id : '');

  // A member picker, never a `<select>` (rule G4) — 无推荐人 first, the same
  // shape `referrerOptions` builds for the staff-facing form, over the
  // narrower (names-only) list this public page is handed.
  const referrerOpts: ComboOption[] = useMemo(
    () => [
      { value: '', label: t('members.noReferrer') },
      ...members.map((m) => ({ value: m.id, label: m.full_name, sub: m.english_name })),
    ],
    [members, t],
  );
  // Only this congregation's own groups — the server refuses a group from a
  // different one anyway, and offering it here would just be a guaranteed
  // error after the rest of the form was filled in.
  const hallGroups = useMemo(() => groups.filter((g) => g.hall_id === hallId), [groups, hallId]);

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
        group_id: form.group_id,
        serving_roles: serving.join(','),
        notes: form.notes.trim(),
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
                  setForm({
                    full_name: '',
                    english_name: '',
                    phone: '',
                    email: '',
                    gender: '',
                    date_of_birth: '',
                    address: '',
                    hall_id: form.hall_id,
                    referred_by: '',
                    group_id: '',
                    notes: '',
                  });
                  setServing([]);
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
              <div className="form-row">
                {/* Where the church would visit them or post something —
                    theirs to give, same as the phone/email above. */}
                <Field label={t('join.field.address')}>
                  <input
                    value={form.address}
                    onChange={(e) => setForm({ ...form, address: e.target.value })}
                  />
                </Field>
                <Field label={t('members.field.referrer')}>
                  <Combobox
                    value={form.referred_by}
                    onChange={(id) => setForm({ ...form, referred_by: id })}
                    options={referrerOpts}
                    ariaLabel={t('members.field.referrer')}
                  />
                </Field>
              </div>
              <div className="form-row">
                {/* Only asked when there is something to choose between: a
                    church with one congregation files everyone in it anyway. */}
                {halls.length > 1 && (
                  <Field label={t('join.field.hall')}>
                    <select value={hallId} onChange={(e) => setForm({ ...form, hall_id: e.target.value, group_id: '' })}>
                      <option value="">{t('hall.choose')}</option>
                      {halls.map((h) => (
                        <option key={h.id} value={h.id}>{h.name}</option>
                      ))}
                    </select>
                  </Field>
                )}
                <Field label={t('members.field.group')}>
                  <select value={form.group_id} onChange={(e) => setForm({ ...form, group_id: e.target.value })}>
                    <option value="">{t('members.filter.ungrouped')}</option>
                    {hallGroups.map((g) => (
                      <option key={g.id} value={g.id}>{g.name}</option>
                    ))}
                  </select>
                </Field>
              </div>
              <Field label={t('members.field.serving')}>
                <TagsInput
                  value={serving}
                  onChange={setServing}
                  suggestions={[]}
                  placeholder={t('members.servingPlaceholder')}
                />
              </Field>
              <Field label={t('member.field.notes')}>
                <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} />
              </Field>
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

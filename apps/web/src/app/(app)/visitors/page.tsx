'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { useFetch } from '@/lib/hooks';
import { useSortableRows } from '@/lib/sort';
import { api } from '@/lib/api';
import { usePageChrome, useMe, useHallScope } from '@/components/AppShell';
import {
  ChevronRightIcon,
  Combobox,
  ErrorBanner,
  ExportButton,
  Field,
  HallSelect,
  LinkIcon,
  MemberName,
  Modal,
  PageBar,
  PhotoPicker,
  RoleRestricted,
  RowChevron,
  SkeletonScreen,
  SkeletonTable,
  SortTh,
  useFormGuard,
  useMemberOptions,
  useToast,
} from '@/components/ui';
import { can } from '@/lib/perms';
import { copyText } from '@/lib/clipboard';
import { exportRows } from '@/lib/export';
import { importFieldKey } from '@/lib/members-import';
import { MemberRow } from '@/lib/types';
import {
  formatDate,
  genderKey,
  GENDER_OPTIONS,
  MEMBER_STATUS_OPTIONS,
  memberRole,
  memberStatusClass,
  memberStatusKey,
  roleKey,
} from '@/lib/labels';
import { churchDateKey } from '@/lib/time';
import { useT } from '@/lib/i18n';
import { AccountRole, ChurchRole, MemberStatus } from '@tog/shared';

/**
 * 访客 — the church's own list of people who have turned up, kept apart from
 * 成员 (0031).
 *
 * It is the SAME table: a visitor is a `members` row whose `church_role` is
 * 访客, which is what makes 转为成员 a single field change that keeps every
 * roll-call tick, every training and every referral they already have. Eleven
 * tables point at `members.id`; a separate `visitors` table would have meant
 * eleven nullable FK pairs and a conversion that copied history between them.
 *
 * What is different is the QUESTION each page asks. This one is about people
 * the church is still getting to know, so it leads with 来访日期 — when they
 * first came, the fact the member list dropped precisely because nobody fills
 * it in about somebody they have known for years — and offers no life group,
 * no group seat and no 服侍岗位: those are what somebody gets after they
 * belong, which is what the 转为成员 button on their own page is for.
 */
export default function VisitorsPage() {
  const router = useRouter();
  const t = useT();
  const toast = useToast();
  const me = useMe();
  const perms = can(me.role);
  const { locked: hallLocked } = useHallScope();
  // Narrowed by the SERVER (rule G2) — this page never sees a member at all,
  // rather than fetching everybody and hiding most of them.
  const { data, initialLoading, error, reload } = useFetch<MemberRow[]>('/members?scope=visitor');
  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [addOpen, setAddOpen] = useState(false);

  usePageChrome({ title: t('visitors.title') }, [t]);

  const visitors = data ?? [];

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    return visitors.filter((m) => {
      if (statusFilter !== 'all' && m.status !== statusFilter) return false;
      // Either name finds a person (0018), whichever one this congregation
      // happens to draw them by.
      if (term && !`${m.full_name} ${m.english_name ?? ''}`.toLowerCase().includes(term)) return false;
      return true;
    });
  }, [visitors, q, statusFilter]);

  const getSortValue = (m: MemberRow, key: string): string | number | null | undefined => {
    switch (key) {
      case 'name':
        return m.full_name;
      case 'visited':
        return m.joined_at ?? undefined;
      case 'hall':
        return m.hall?.name ?? undefined;
      case 'phone':
        return m.phone ?? undefined;
      case 'referrer':
        return m.referrer?.full_name ?? undefined;
      case 'status':
        return t(memberStatusKey(m.status));
      default:
        return undefined;
    }
  };
  // Newest visit first, which is the one order this list is ever read in:
  // who has come recently and still needs following up. `joined_at` is
  // nullable and nulls sort last either way, so a visitor nobody dated is at
  // the bottom rather than pretending to be the most recent.
  const { sorted, sortKey, sortDir, toggleSort } = useSortableRows(rows, getSortValue, {
    key: 'visited',
    dir: 'desc',
    tiebreak: ['name'],
  });

  const exportVisitors = () => {
    exportRows(
      t('visitors.title'),
      t('visitors.col.visitor'),
      sorted.map((m) => ({
        [t('export.name')]: m.full_name,
        [t('members.field.englishName')]: m.english_name ?? '',
        [t(importFieldKey('joined_at'))]: m.joined_at ?? '',
        [t('export.phone')]: m.phone ?? '',
        [t('export.email')]: m.email ?? '',
        [t(importFieldKey('address'))]: m.address ?? '',
        [t(importFieldKey('referred_by'))]: m.referrer
          ? [m.referrer.full_name, m.referrer.english_name].filter(Boolean).join(' ')
          : '',
        [t('member.field.gender')]: m.gender ? t(genderKey(m.gender)) : '',
        [t('export.status')]: t(memberStatusKey(m.status)),
        [t('member.field.notes')]: m.notes ?? '',
      })),
    );
  };

  // The public first-visit form's own link — the visitor half of what
  // /members hands out for members (rule G4, same helper, same "say either
  // way" rule: through `navigator.clipboard` alone an in-app browser does
  // nothing at all and the button reads as broken).
  const copyVisitLink = async () => {
    const link = `${window.location.origin}/welcome`;
    if (await copyText(link)) toast(t('members.toast.linkCopied'));
    else toast(t('common.copyFailed', { link }), 'error');
  };

  // Same boundary /members has: a group_leader's reach is one life group's
  // roster, and a visitor list is the congregation's, not a group's.
  if (me.role === AccountRole.GroupLeader) return <RoleRestricted />;

  return (
    <>
      <ErrorBanner message={error} />

      <PageBar
        filters={
          <>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('members.searchPlaceholder')} />
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="all">{t('members.col.status')} ({visitors.length})</option>
              {MEMBER_STATUS_OPTIONS.map((st) => (
                <option key={st} value={st}>
                  {t(memberStatusKey(st))} ({visitors.filter((m) => m.status === st).length})
                </option>
              ))}
            </select>
          </>
        }
        actions={
          <>
            <ExportButton onClick={exportVisitors} disabled={sorted.length === 0} />
            {perms.write && (
              <button className="btn ghost" onClick={copyVisitLink} title={t('visitors.registerLinkTitle')}>
                <LinkIcon />
                {t('visitors.registerLink')}
              </button>
            )}
            {perms.write && (
              <button className="btn" onClick={() => setAddOpen(true)}>{t('visitors.add')}</button>
            )}
          </>
        }
      />

      {initialLoading ? (
        <SkeletonScreen>
          <SkeletonTable rows={8} columns={hallLocked ? 6 : 7} />
        </SkeletonScreen>
      ) : (
        <>
          {/* Desktop — table */}
          <div className="card only-desktop" style={{ padding: 6 }}>
            <div className="table-wrap">
              <table className="table-fixed">
                <thead>
                  <tr>
                    <SortTh sortKey="name" activeKey={sortKey} dir={sortDir} onSort={toggleSort}>{t('visitors.col.visitor')}</SortTh>
                    <SortTh sortKey="visited" activeKey={sortKey} dir={sortDir} onSort={toggleSort}>{t('member.field.joined')}</SortTh>
                    {!hallLocked && (
                      <SortTh sortKey="hall" activeKey={sortKey} dir={sortDir} onSort={toggleSort}>{t('hall.label')}</SortTh>
                    )}
                    <SortTh sortKey="phone" activeKey={sortKey} dir={sortDir} onSort={toggleSort}>{t('members.col.contact')}</SortTh>
                    <SortTh sortKey="referrer" activeKey={sortKey} dir={sortDir} onSort={toggleSort}>{t('members.field.referrer')}</SortTh>
                    <SortTh sortKey="status" activeKey={sortKey} dir={sortDir} onSort={toggleSort}>{t('members.col.status')}</SortTh>
                    <th>{t('members.col.remark')}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((m) => (
                    <tr key={m.id}>
                      <td>
                        <MemberName member={m} />
                      </td>
                      <td className="muted tnum">{formatDate(m.joined_at)}</td>
                      {!hallLocked && <td className="muted">{m.hall?.name ?? '—'}</td>}
                      <td className="muted tnum">{m.phone ?? '—'}</td>
                      <td className="muted">
                        {m.referrer ? <MemberName member={m.referrer} /> : '—'}
                      </td>
                      <td>
                        <span className={`badge ${memberStatusClass(m.status)}`}>
                          {t(memberStatusKey(m.status))}
                        </span>
                      </td>
                      <td className="muted cell-remark" title={m.notes ?? undefined}>
                        {m.notes ?? ''}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <RowChevron title={t('members.viewProfile')} onClick={() => router.push(`/members/${m.id}`)} />
                      </td>
                    </tr>
                  ))}
                  {sorted.length === 0 && (
                    <tr>
                      <td colSpan={hallLocked ? 7 : 8} className="empty-inline">
                        {t('visitors.empty')}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Mobile — the canonical tile: what the row IS on row 1 with its ONE
              identifying tag pinned right, every other fact on a line of its
              own. Here that tag is the visit DATE rather than a role badge —
              every row on this page is a 访客, so a column of identical badges
              would say nothing, while when they came is the thing being
              scanned for. */}
          <div className="only-mobile">
            {sorted.map((m) => (
              <div key={m.id} className="mtile" onClick={() => router.push(`/members/${m.id}`)}>
                <div className="mtile-row1">
                  <MemberName member={m} />
                  <div className="flex items-center gap-8" style={{ flexShrink: 0 }}>
                    <span className="muted tnum">{formatDate(m.joined_at)}</span>
                    <span className="mtile-cta"><ChevronRightIcon /></span>
                  </div>
                </div>
                {m.phone && <div className="mtile-line">{m.phone}</div>}
                {m.referrer && (
                  <div className="mtile-line">
                    {t('visitors.referredBy')} <MemberName member={m.referrer} />
                  </div>
                )}
                {m.status !== MemberStatus.Active && (
                  <div className="mtile-line">
                    <span className={`badge ${memberStatusClass(m.status)}`}>
                      {t(memberStatusKey(m.status))}
                    </span>
                  </div>
                )}
                {m.notes && (
                  <div className="mtile-line cell-remark" title={m.notes}>
                    {m.notes}
                  </div>
                )}
              </div>
            ))}
            {sorted.length === 0 && <div className="empty-inline">{t('visitors.empty')}</div>}
          </div>
        </>
      )}

      <div className="hint mt-14">{t('visitors.hint')}</div>

      {addOpen && (
        <AddVisitorModal
          onClose={() => setAddOpen(false)}
          onSaved={() => {
            setAddOpen(false);
            toast(t('visitors.toast.created'));
            reload();
          }}
        />
      )}
    </>
  );
}

/**
 * The 访客 form. Deliberately SHORTER than the member one rather than the same
 * form with fields disabled: what the church knows about somebody who walked
 * in on Sunday is their name, a number, who brought them and when they came —
 * and asking for a life group, a seat in it and a 服侍岗位 at that moment is
 * asking about things that only exist once they belong.
 *
 * `church_role` is not a control at all here. Every row this form makes is a
 * 访客 (`VISITOR_ROLE_OPTIONS` is that list, and it has one entry), and the
 * way across the split is the 转为成员 button on the person's own page.
 */
function AddVisitorModal({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const { halls, hallId } = useHallScope();
  const [form, setForm] = useState({
    full_name: '',
    english_name: '',
    phone: '',
    email: '',
    address: '',
    referred_by: '',
    gender: '',
    date_of_birth: '',
    // 来访日期 — the fact this page is built around, so it is offered filled in
    // with today rather than blank: somebody entering a visitor is almost
    // always entering the one who came this Sunday, and a date they have to
    // remember to set is a date that ends up null.
    joined_at: todayInChurch(),
    notes: '',
    hall_id: (hallId || null) as string | null,
  });
  const [photo, setPhoto] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { close } = useFormGuard({ form, photo: photo?.name ?? null }, onClose);

  // The WHOLE roll, not this page's visitors — the person who brought them is
  // usually a member (rule G4: one builder for every member picker).
  const allMembers = useFetch<MemberRow[]>('/members');
  const memberOptions = useMemberOptions();
  const referrerOpts = useMemo(
    () =>
      memberOptions(allMembers.data ?? [], {
        lead: { value: '', label: t('members.noReferrer') },
        hint: (m) => t(roleKey(memberRole(m as MemberRow))),
      }),
    [allMembers.data, memberOptions, t],
  );

  const effectiveHallId = form.hall_id ?? (halls.length === 1 ? halls[0].id : null);

  const save = async () => {
    if (!form.full_name.trim()) {
      setErr(t('members.err.name'));
      return;
    }
    if (!effectiveHallId) {
      setErr(t('members.err.hall'));
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const created = await api.post<MemberRow>('/members', {
        full_name: form.full_name.trim(),
        english_name: form.english_name || undefined,
        phone: form.phone || undefined,
        email: form.email || undefined,
        address: form.address || undefined,
        referred_by: form.referred_by || null,
        gender: form.gender || undefined,
        date_of_birth: form.date_of_birth || undefined,
        joined_at: form.joined_at || undefined,
        notes: form.notes || undefined,
        hall_id: effectiveHallId,
        church_role: ChurchRole.Visitor,
      });
      // Same order the member form uses (rule G4): the row first, the photo
      // onto it after — so nothing reaches storage for somebody the database
      // refused (a duplicate name pair, say).
      if (photo) {
        const fd = new FormData();
        fd.append('file', photo);
        await api.upload(`/members/${created.id}/avatar`, fd);
      }
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={t('visitors.new.title')} onClose={close}>
      {err && <ErrorBanner message={err} />}
      <div className="form-row">
        <Field label={t('members.field.name')}>
          <input value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} />
        </Field>
        <Field label={t('members.field.englishName')}>
          <input value={form.english_name} onChange={(e) => setForm({ ...form, english_name: e.target.value })} />
        </Field>
      </div>
      <div className="form-row">
        <Field label={t('members.field.phone')}>
          <input
            value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
            placeholder="012-000 0000"
          />
        </Field>
        <Field label={t('members.field.email')}>
          <input
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            placeholder="name@grace.org"
          />
        </Field>
      </div>
      <div className="form-row">
        <Field label={t('member.field.joined')}>
          <input
            type="date"
            className={form.joined_at ? undefined : 'date-empty'}
            value={form.joined_at}
            onChange={(e) => setForm({ ...form, joined_at: e.target.value })}
          />
        </Field>
        <Field label={t('hall.label')}>
          <HallSelect value={effectiveHallId} onChange={(id) => setForm({ ...form, hall_id: id })} />
        </Field>
      </div>
      <div className="form-row">
        <Field label={t('member.field.gender')}>
          <select value={form.gender} onChange={(e) => setForm({ ...form, gender: e.target.value })}>
            <option value="">—</option>
            {GENDER_OPTIONS.map((g) => (
              <option key={g} value={g}>{t(genderKey(g))}</option>
            ))}
          </select>
        </Field>
        <Field label={t('member.field.birthday')}>
          <input
            type="date"
            className={form.date_of_birth ? undefined : 'date-empty'}
            value={form.date_of_birth}
            onChange={(e) => setForm({ ...form, date_of_birth: e.target.value })}
          />
        </Field>
      </div>
      <div className="form-row">
        <Field label={t('members.field.address')}>
          <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
        </Field>
        <Field label={t('members.field.referrer')}>
          {/* A member picker is a Combobox, never a `<select>` (rule G4) — and
              its first option is the default rather than an empty field. Who
              brought somebody is the most useful thing on this whole form. */}
          <Combobox
            value={form.referred_by}
            onChange={(id) => setForm({ ...form, referred_by: id })}
            options={referrerOpts}
            ariaLabel={t('members.field.referrer')}
          />
        </Field>
      </div>
      <Field label={t('member.field.notes')}>
        <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} />
      </Field>
      <Field label={t('members.field.photo')}>
        <PhotoPicker file={photo} onChange={setPhoto} name={form.full_name} />
      </Field>
      <div className="hint" style={{ marginBottom: 6 }}>{t('photo.hint')}</div>
      <div className="modal-actions">
        <button className="btn ghost" onClick={close}>{t('common.cancel')}</button>
        <button className="btn" onClick={save} disabled={saving}>
          {saving ? t('common.saving') : t('common.save')}
        </button>
      </div>
    </Modal>
  );
}

/**
 * Today, as a `YYYY-MM-DD` the church would recognise — Malaysia time, never
 * the browser's own zone (rule G6a). A visitor entered late on a Sunday night
 * from a phone set to another country would otherwise be dated Monday.
 */
function todayInChurch(): string {
  return churchDateKey(new Date());
}

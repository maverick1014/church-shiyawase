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
  RoleBadge,
  RowChevron,
  SkeletonScreen,
  SkeletonTable,
  SortTh,
  TagsInput,
  useToast,
} from '@/components/ui';
import { ImportMembersModal } from '@/components/ImportMembersModal';
import { can } from '@/lib/perms';
import { copyText } from '@/lib/clipboard';
import { exportRows } from '@/lib/export';
import { importFieldKey } from '@/lib/members-import';
import { GroupDetail, GroupRow, MemberRow } from '@/lib/types';
import {
  CHURCH_ROLE_OPTIONS,
  churchRoleKey,
  formatDate,
  genderKey,
  GROUP_POSITION_OPTIONS,
  MEMBER_ROLE_FILTERS,
  memberRole,
  memberStatusClass,
  memberStatusKey,
  positionKey,
  referrerOptions,
  roleKey,
} from '@/lib/labels';
import { useT } from '@/lib/i18n';
import { ChurchRole, GroupPosition, LEADERSHIP_POSITIONS, MemberStatus } from '@tog/shared';

const UNASSIGNED = '__unassigned__';

export default function MembersPage() {
  const router = useRouter();
  const t = useT();
  const toast = useToast();
  const perms = can(useMe().role);
  // Only worth a column when the account can actually see more than one hall.
  const { locked: hallLocked } = useHallScope();
  const { data, initialLoading, error, reload } = useFetch<MemberRow[]>('/members');
  const [q, setQ] = useState('');
  const [roleFilter, setRoleFilter] = useState<string>('all');
  const [groupFilter, setGroupFilter] = useState<string>('all');
  // The STORED ministry, never its label — 服侍岗位 is free text the church
  // typed, so there is nothing to translate and nothing that may be keyed by a
  // translation (rule G8).
  const [servingFilter, setServingFilter] = useState<string>('all');
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  usePageChrome({ title: t('members.title') }, [t]);

  const members = data ?? [];

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: members.length };
    MEMBER_ROLE_FILTERS.forEach((r) => (c[r] = 0));
    for (const m of members) {
      const r = memberRole(m);
      if (c[r] != null) c[r]++;
    }
    return c;
  }, [members]);

  // Life-group filter options, derived from the already-fetched member list
  // (no extra request — G5: derive once instead of fetching the same data twice).
  const groupOptions = useMemo(() => {
    const map = new Map<string, { id: string; name: string; count: number }>();
    let unassigned = 0;
    for (const m of members) {
      if (m.group) {
        const g = map.get(m.group.id) ?? { id: m.group.id, name: m.group.name, count: 0 };
        g.count++;
        map.set(m.group.id, g);
      } else {
        unassigned++;
      }
    }
    return {
      groups: [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh')),
      unassigned,
    };
  }, [members]);

  // Every 服侍岗位 anybody actually serves in, for the filter and for the two
  // forms' autocomplete — derived from the list already fetched (G5), exactly
  // the way /groups derives its tags.
  const allServing = useMemo(() => {
    const set = new Set<string>();
    for (const m of members) for (const r of m.serving_roles ?? []) set.add(r);
    return [...set].sort((a, b) => a.localeCompare(b, 'zh'));
  }, [members]);

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    return members.filter((m) => {
      const role = memberRole(m);
      if (roleFilter !== 'all' && role !== roleFilter) return false;
      if (servingFilter !== 'all' && !(m.serving_roles ?? []).includes(servingFilter)) return false;
      if (groupFilter === UNASSIGNED) {
        if (m.group) return false;
      } else if (groupFilter !== 'all' && m.group?.id !== groupFilter) {
        return false;
      }
      // Either name finds a person (0018), and case-insensitively: an English
      // name is typed "john" as often as "John", while a Chinese name is
      // unaffected by lowercasing.
      if (term && !`${m.full_name} ${m.english_name ?? ''}`.toLowerCase().includes(term)) return false;
      return true;
    });
  }, [members, q, roleFilter, groupFilter, servingFilter]);

  const getSortValue = (m: MemberRow, key: string): string | number | null | undefined => {
    switch (key) {
      case 'name':
        return m.full_name;
      case 'role':
        return (MEMBER_ROLE_FILTERS as readonly string[]).indexOf(memberRole(m));
      case 'group':
        return m.group?.name ?? undefined;
      case 'hall':
        return m.hall?.name ?? undefined;
      case 'phone':
        return m.phone ?? undefined;
      case 'status':
        return t(memberStatusKey(m.status));
      case 'joined':
        return m.joined_at ?? undefined;
      default:
        return undefined;
    }
  };
  const { sorted, sortKey, sortDir, toggleSort } = useSortableRows(rows, getSortValue, {
    key: 'role',
    dir: 'asc',
  });

  const exportMembers = () => {
    exportRows(
      t('members.title'),
      t('members.col.member'),
      sorted.map((m) => ({
        [t('export.name')]: m.full_name,
        [t('members.field.englishName')]: m.english_name ?? '',
        [t('export.role')]: t(roleKey(memberRole(m))),
        [t('export.group')]: m.group?.name ?? t('members.filter.ungrouped'),
        [t('export.email')]: m.email ?? '',
        [t('export.phone')]: m.phone ?? '',
        [t(importFieldKey('address'))]: m.address ?? '',
        // The referrer's own pair, written the way the importer reads one back
        // — so an exported list can be edited and uploaded straight again.
        [t(importFieldKey('referred_by'))]: m.referrer
          ? [m.referrer.full_name, m.referrer.english_name].filter(Boolean).join(' ')
          : '',
        [t('member.field.gender')]: m.gender ? t(genderKey(m.gender)) : '',
        // The IMPORTER's own header and the importer's own separator, so a list
        // exported here can be edited and uploaded straight back (the column
        // list in `lib/members-import.ts` is the one definition of both).
        [t(importFieldKey('serving_roles'))]: (m.serving_roles ?? []).join('、'),
        [t('export.status')]: t(memberStatusKey(m.status)),
        [t('export.joined')]: formatDate(m.joined_at),
      })),
    );
  };

  // Copy, and SAY so either way — through `navigator.clipboard` alone an in-app
  // browser does nothing at all and the button reads as broken
  // (`lib/clipboard.ts` explains the fallback).
  const copyRegisterLink = async () => {
    const link = `${window.location.origin}/join`;
    if (await copyText(link)) toast(t('members.toast.linkCopied'));
    else toast(t('common.copyFailed', { link }), 'error');
  };

  // No early return: the filters and the actions render perfectly well against
  // an empty list, so the real chrome goes up immediately and only the rows
  // below it are skeletons — nothing moves when the fetch lands.
  return (
    <>
      <ErrorBanner message={error} />

      <PageBar
        filters={
          <>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('members.searchPlaceholder')} />
            <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}>
              <option value="all">{t('members.filter.role')} ({counts.all})</option>
              {MEMBER_ROLE_FILTERS.map((r) => (
                <option key={r} value={r}>{t(roleKey(r))} ({counts[r] ?? 0})</option>
              ))}
            </select>
            <select value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)}>
              <option value="all">{t('members.filter.group')}</option>
              {groupOptions.groups.map((g) => (
                <option key={g.id} value={g.id}>{g.name} ({g.count})</option>
              ))}
              <option value={UNASSIGNED}>{t('members.filter.ungrouped')} ({groupOptions.unassigned})</option>
            </select>
            {/* Only offered once somebody serves somewhere — a dropdown with a
                single "all" option asks a question the church cannot answer. */}
            {allServing.length > 0 && (
              <select value={servingFilter} onChange={(e) => setServingFilter(e.target.value)}>
                <option value="all">{t('members.filter.serving')}</option>
                {allServing.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            )}
          </>
        }
        actions={
          <>
            <ExportButton onClick={exportMembers} disabled={sorted.length === 0} />
            {/* The public self-registration link lives HERE rather than on
                教会设置: it is a link that produces MEMBERS, so the person who
                hands it out is the one watching this list fill up — and
                教会设置 is super_admin-only, while an admin who manages the
                roll may never open it at all. */}
            {perms.write && (
              <button className="btn ghost" onClick={copyRegisterLink} title={t('members.registerLinkTitle')}>
                <LinkIcon />
                {t('members.registerLink')}
              </button>
            )}
            {/* Bulk create-and-overwrite, so it is held to the same bar as a
                delete — super_admin / admin. The server refuses the path for
                every other role regardless (rule G2). */}
            {perms.delete && (
              <button className="btn ghost" onClick={() => setImportOpen(true)}>{t('members.import')}</button>
            )}
            {perms.write && (
              <button className="btn" onClick={() => setAddOpen(true)}>{t('members.add')}</button>
            )}
          </>
        }
      />

      {initialLoading ? (
        <SkeletonScreen>
          <SkeletonTable rows={8} columns={hallLocked ? 7 : 8} />
        </SkeletonScreen>
      ) : (
        <>
          {/* Desktop — table */}
          <div className="card only-desktop" style={{ padding: 6 }}>
            <div className="table-wrap">
              <table className="table-fixed">
                <thead>
                  <tr>
                    {/* Member / identity / group / contact share the width equally;
                        the utility columns (status / joined) + chevron stay narrow. */}
                    <SortTh sortKey="name" activeKey={sortKey} dir={sortDir} onSort={toggleSort}>{t('members.col.member')}</SortTh>
                    <SortTh sortKey="role" activeKey={sortKey} dir={sortDir} onSort={toggleSort}>{t('members.col.role')}</SortTh>
                    {!hallLocked && (
                      <SortTh sortKey="hall" activeKey={sortKey} dir={sortDir} onSort={toggleSort}>{t('hall.label')}</SortTh>
                    )}
                    <SortTh sortKey="group" activeKey={sortKey} dir={sortDir} onSort={toggleSort}>{t('members.col.group')}</SortTh>
                    <SortTh sortKey="phone" activeKey={sortKey} dir={sortDir} onSort={toggleSort}>{t('members.col.contact')}</SortTh>
                    <SortTh sortKey="status" activeKey={sortKey} dir={sortDir} onSort={toggleSort}>{t('members.col.status')}</SortTh>
                    <SortTh sortKey="joined" activeKey={sortKey} dir={sortDir} onSort={toggleSort}>{t('members.col.joined')}</SortTh>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((m) => {
                    const role = memberRole(m);
                    return (
                      <tr key={m.id}>
                        <td>
                          <MemberName member={m} />
                        </td>
                        <td>
                          <RoleBadge role={role} />
                        </td>
                        {!hallLocked && <td className="muted">{m.hall?.name ?? '—'}</td>}
                        <td className="muted">{m.group?.name ?? t('members.filter.ungrouped')}</td>
                        <td className="muted tnum">{m.phone ?? '—'}</td>
                        <td>
                          <span className={`badge ${memberStatusClass(m.status)}`}>
                            {t(memberStatusKey(m.status))}
                          </span>
                        </td>
                        <td className="muted tnum">{formatDate(m.joined_at)}</td>
                        <td style={{ textAlign: 'right' }}>
                          <RowChevron title={t('members.viewProfile')} onClick={() => router.push(`/members/${m.id}`)} />
                        </td>
                      </tr>
                    );
                  })}
                  {sorted.length === 0 && (
                    <tr>
                      <td colSpan={hallLocked ? 7 : 8} className="empty-inline">
                        {t('members.empty')}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Mobile — list tiles: name + group + identity, contact, status + joined */}
          <div className="only-mobile">
            {sorted.map((m) => {
              const role = memberRole(m);
              return (
                <div key={m.id} className="mtile" onClick={() => router.push(`/members/${m.id}`)}>
                  <div className="mtile-row1">
                    <div className="flex items-center gap-8 flex-wrap" style={{ minWidth: 0 }}>
                      <MemberName member={m} />
                      <span className="muted" style={{ fontSize: 12.5 }}>· {m.group?.name ?? t('members.filter.ungrouped')}</span>
                      <RoleBadge role={role} />
                    </div>
                    <span className="mtile-cta"><ChevronRightIcon /></span>
                  </div>
                  {/* Only render detail lines that have real content — a tile with no
                      phone/date shouldn't show bare “—” placeholder rows. */}
                  {m.phone && <div className="mtile-line">{m.phone}</div>}
                  {(m.status !== MemberStatus.Active || m.joined_at) && (
                    <div className="mtile-line">
                      {/* Active is the norm — only surface the status when it isn't. */}
                      {m.status !== MemberStatus.Active && (
                        <span className={`badge ${memberStatusClass(m.status)}`}>
                          {t(memberStatusKey(m.status))}
                        </span>
                      )}
                      {m.joined_at && <span>{formatDate(m.joined_at)}</span>}
                    </div>
                  )}
                </div>
              );
            })}
            {sorted.length === 0 && <div className="empty-inline">{t('members.empty')}</div>}
          </div>
        </>
      )}

      <div className="hint mt-14">{t('members.hint')}</div>

      {addOpen && (
        <AddMemberModal
          members={members}
          servingSuggestions={allServing}
          onClose={() => setAddOpen(false)}
          onSaved={() => {
            setAddOpen(false);
            toast(t('members.toast.created'));
            reload();
          }}
        />
      )}

      {importOpen && (
        <ImportMembersModal onClose={() => setImportOpen(false)} onDone={reload} />
      )}
    </>
  );
}

function AddMemberModal({
  members,
  servingSuggestions,
  onClose,
  onSaved,
}: {
  /** The roll this page already fetched — the 推荐人 picker's options (G5). */
  members: MemberRow[];
  /** The 服侍岗位 the church already uses — the list is free text, so the only
   *  thing standing between 敬拜 and 敬拜团 is what somebody typed last time. */
  servingSuggestions: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const allGroups = useFetch<GroupRow[]>('/groups');
  const { halls, hallId } = useHallScope();
  const [form, setForm] = useState({
    full_name: '',
    english_name: '',
    phone: '',
    email: '',
    address: '',
    // '' = 无推荐人, and that is what the column stores: nobody referred them is
    // the ordinary case, not a value the church has still to fill in.
    referred_by: '',
    group_id: '',
    // Default to the hall currently being viewed; a hall-scoped account only
    // ever has one option anyway (the server pins it regardless).
    hall_id: (hallId || null) as string | null,
    church_role: ChurchRole.Member as ChurchRole,
    group_position: GroupPosition.NewMember as GroupPosition,
  });
  const [serving, setServing] = useState<string[]>([]);
  const [photo, setPhoto] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Only fetched to auto-demote an incumbent if this new member is placed
  // straight into a leadership slot (one holder per leadership position
  // per group — same rule as 小组管理 and the member-edit modal).
  const groupDetail = useFetch<GroupDetail>(form.group_id ? `/groups/${form.group_id}` : null);

  // A member always belongs to exactly one hall (DB NOT NULL). When there is
  // only one option, use it without making the user pick.
  const effectiveHallId = form.hall_id ?? (halls.length === 1 ? halls[0].id : null);

  // Nobody to exclude: the person does not exist yet, so they cannot be their
  // own referrer.
  const referrerOpts = useMemo(() => referrerOptions(members, t), [members, t]);

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
      if (form.group_id && LEADERSHIP_POSITIONS.includes(form.group_position)) {
        const incumbent = (groupDetail.data?.members ?? []).find(
          (m) => m.group_position === form.group_position,
        );
        if (incumbent) {
          await api.patch(`/members/${incumbent.id}`, { group_position: GroupPosition.CoreMember });
        }
      }
      const created = await api.post<{ id: string }>('/members', {
        full_name: form.full_name.trim(),
        english_name: form.english_name || undefined,
        phone: form.phone || undefined,
        email: form.email || undefined,
        address: form.address || undefined,
        referred_by: form.referred_by || null,
        hall_id: effectiveHallId,
        church_role: form.church_role,
        group_id: form.group_id || undefined,
        group_position: form.group_id ? form.group_position : undefined,
        serving_roles: serving,
      });
      // The photo goes through the SAME endpoint the member's own profile page
      // uses (rule G4), once the row exists to hang it on — so nothing reaches
      // storage for a member the database refused (a duplicate name pair, say).
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
    <Modal title={t('members.new.title')} onClose={onClose}>
      {err && <ErrorBanner message={err} />}
      <div className="form-row">
        <Field label={t('members.field.name')}>
          <input
            value={form.full_name}
            onChange={(e) => setForm({ ...form, full_name: e.target.value })}
          />
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
        <Field label={t('members.field.address')}>
          <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
        </Field>
        <Field label={t('members.field.referrer')}>
          {/* A member picker is a Combobox, never a `<select>` (rule G4) — and
              its first option is the default rather than an empty field, so
              「无推荐人」is something the church chose, not something it forgot. */}
          <Combobox
            value={form.referred_by}
            onChange={(id) => setForm({ ...form, referred_by: id })}
            options={referrerOpts}
            ariaLabel={t('members.field.referrer')}
          />
        </Field>
      </div>
      <div className="form-row">
        <Field label={t('hall.label')}>
          <HallSelect value={effectiveHallId} onChange={(id) => setForm({ ...form, hall_id: id })} />
        </Field>
        <Field label={t('members.field.group')}>
          <select value={form.group_id} onChange={(e) => setForm({ ...form, group_id: e.target.value })}>
            <option value="">{t('members.filter.ungrouped')}</option>
            {(allGroups.data ?? []).map((g) => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))}
          </select>
        </Field>
      </div>
      <div className="form-row">
        <Field label={t('members.field.churchRole')}>
          <select value={form.church_role} onChange={(e) => setForm({ ...form, church_role: e.target.value as ChurchRole })}>
            {CHURCH_ROLE_OPTIONS.map((cr) => (
              <option key={cr} value={cr}>{t(churchRoleKey(cr))}</option>
            ))}
          </select>
        </Field>
        {form.group_id && (
          <Field label={t('members.field.groupRole')}>
            <select
              value={form.group_position}
              onChange={(e) => setForm({ ...form, group_position: e.target.value as GroupPosition })}
            >
              {GROUP_POSITION_OPTIONS.map((p) => (
                <option key={p} value={p}>{t(positionKey(p))}</option>
              ))}
            </select>
          </Field>
        )}
      </div>
      <Field label={t('members.field.serving')}>
        <TagsInput
          value={serving}
          onChange={setServing}
          suggestions={servingSuggestions}
          placeholder={t('members.servingPlaceholder')}
        />
      </Field>
      <Field label={t('members.field.photo')}>
        <PhotoPicker file={photo} onChange={setPhoto} name={form.full_name} />
      </Field>
      <div className="hint" style={{ marginBottom: 6 }}>{t('photo.hint')}</div>
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn" onClick={save} disabled={saving}>
          {saving ? t('common.saving') : t('common.save')}
        </button>
      </div>
    </Modal>
  );
}

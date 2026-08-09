'use client';

import { useMemo, useState } from 'react';
import { useFetch } from '@/lib/hooks';
import { api } from '@/lib/api';
import { GroupDetail, GroupRow, LeaderAccountEvent, MemberRow } from '@/lib/types';
import { ChurchRole, Gender, GroupPosition, LEADERSHIP_POSITIONS, MemberStatus } from '@tog/shared';
import {
  CHURCH_ROLE_OPTIONS,
  churchRoleKey,
  genderKey,
  GENDER_OPTIONS,
  GROUP_POSITION_OPTIONS,
  MEMBER_STATUS_OPTIONS,
  memberStatusKey,
  positionKey,
  referrerOptions,
} from '@/lib/labels';
import { useT } from '@/lib/i18n';
import { Combobox, ErrorBanner, Field, HallSelect, Modal, TagsInput, useToast } from './ui';

/**
 * The shared member-edit form (rule G4) — extracted out of the member-detail
 * page so `/groups/[id]`'s roster can open the SAME editor for a row's
 * member, rather than a second, drifting copy of this form. Carries the full
 * edit behaviour it always has: the leadership auto-demote (promoting someone
 * into a leadership slot first demotes the incumbent) and the same field set,
 * `group_joined_at` and `notes` included.
 */
export function MemberEditModal({
  member,
  onClose,
  onSaved,
}: {
  member: MemberRow;
  onClose: () => void;
  /**
   * Every `leader_account_event` either write below produced, paired with
   * whose event it is — the member being saved (a promotion/demotion of
   * THEIR OWN seat) and/or the incumbent this save auto-demoted out of a
   * leadership slot (which itself demotes them out of 小组长 when that slot
   * was specifically Leader). The caller renders each through
   * `useLeaderAccountEvent` — passed up rather than shown here, because
   * `onSaved` typically unmounts this modal immediately (rule G6: a created
   * credential has to outlive that).
   */
  onSaved: (leaderEvents?: Array<{ event: LeaderAccountEvent; name: string }>) => void;
}) {
  // 服侍岗位 is a list, so it is its own piece of state rather than a string in
  // the form object — the same shape a group's tags are edited in.
  const [serving, setServing] = useState<string[]>(member.serving_roles ?? []);
  const [form, setForm] = useState({
    full_name: member.full_name ?? '',
    english_name: member.english_name ?? '',
    phone: member.phone ?? '',
    email: member.email ?? '',
    address: member.address ?? '',
    // '' = 无推荐人, which is what the column stores as NULL.
    referred_by: member.referred_by ?? '',
    gender: member.gender ?? '',
    date_of_birth: member.date_of_birth ?? '',
    joined_at: member.joined_at ?? '',
    // 加入小组日期 — a separate fact from `joined_at` (migration 0023).
    group_joined_at: member.group_joined_at ?? '',
    status: member.status,
    notes: member.notes ?? '',
    church_role: member.church_role,
    hall_id: member.hall_id as string | null,
    group_id: member.group_id ?? '',
    group_position: member.group_position ?? GroupPosition.NewMember,
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const t = useT();
  const toast = useToast();

  const allGroups = useFetch<GroupRow[]>('/groups');
  // The whole roll, only to autocomplete 服侍岗位 from the ministries the church
  // already uses — free text drifts into 敬拜 / 敬拜团 / 敬拜组 otherwise. Same
  // derivation as /groups' tag suggestions (rule G4).
  const allMembers = useFetch<MemberRow[]>('/members');
  const servingSuggestions = useMemo(() => {
    const set = new Set<string>();
    for (const other of allMembers.data ?? [])
      for (const r of other.serving_roles ?? []) set.add(r);
    return [...set].sort((a, b) => a.localeCompare(b, 'zh'));
  }, [allMembers.data]);
  // The 推荐人 picker draws on the same roll — and never offers this person,
  // because the database refuses a self-referral and a user must not be able
  // to walk into that error.
  const referrerOpts = useMemo(
    () => referrerOptions(allMembers.data ?? [], t, member.id),
    [allMembers.data, t, member.id],
  );
  // Sibling members of whichever group is currently SELECTED (not necessarily
  // the member's original group) — used to auto-demote whoever currently
  // holds a leadership slot when someone new is assigned to it (one holder
  // per leadership position per group).
  const groupDetail = useFetch<GroupDetail>(form.group_id ? `/groups/${form.group_id}` : null);

  const changeGroup = (groupId: string) => {
    setForm({
      ...form,
      group_id: groupId,
      group_position:
        groupId === (member.group_id ?? '')
          ? member.group_position ?? GroupPosition.NewMember
          : GroupPosition.NewMember,
    });
  };

  const save = async () => {
    if (!form.full_name.trim()) {
      setErr(t('members.err.name'));
      return;
    }
    setSaving(true);
    setErr(null);
    const leaderEvents: Array<{ event: LeaderAccountEvent; name: string }> = [];
    try {
      if (form.group_id && LEADERSHIP_POSITIONS.includes(form.group_position)) {
        const incumbent = (groupDetail.data?.members ?? []).find(
          (m) => m.id !== member.id && m.group_position === form.group_position,
        );
        if (incumbent) {
          const demoted = await api.patch<MemberRow>(`/members/${incumbent.id}`, {
            group_position: GroupPosition.CoreMember,
          });
          if (demoted.leader_account_event)
            leaderEvents.push({ event: demoted.leader_account_event, name: incumbent.full_name });
        }
      }
      const updated = await api.patch<MemberRow>(`/members/${member.id}`, {
        full_name: form.full_name.trim(),
        english_name: form.english_name || null,
        phone: form.phone || null,
        email: form.email || null,
        address: form.address || null,
        referred_by: form.referred_by || null,
        gender: form.gender || null,
        date_of_birth: form.date_of_birth || null,
        joined_at: form.joined_at || null,
        group_joined_at: form.group_joined_at || null,
        status: form.status,
        notes: form.notes || null,
        church_role: form.church_role,
        hall_id: form.hall_id,
        group_id: form.group_id || null,
        group_position: form.group_id ? form.group_position : null,
        serving_roles: serving,
      });
      if (updated.leader_account_event)
        leaderEvents.push({ event: updated.leader_account_event, name: form.full_name.trim() });
      onSaved(leaderEvents);
    } catch (e) {
      setErr((e as Error).message);
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={t('member.edit.title')} onClose={onClose}>
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
          <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="012-000 0000" />
        </Field>
        <Field label={t('members.field.email')}>
          <input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="name@grace.org" />
        </Field>
      </div>
      <div className="form-row">
        <Field label={t('members.field.address')}>
          <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
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
        <Field label={t('member.field.gender')}>
          <select value={form.gender} onChange={(e) => setForm({ ...form, gender: e.target.value as Gender | '' })}>
            <option value="">{t('common.unset')}</option>
            {GENDER_OPTIONS.map((g) => (
              <option key={g} value={g}>{t(genderKey(g))}</option>
            ))}
          </select>
        </Field>
        <Field label={t('members.col.status')}>
          <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as MemberStatus })}>
            {MEMBER_STATUS_OPTIONS.map((st) => (
              <option key={st} value={st}>{t(memberStatusKey(st))}</option>
            ))}
          </select>
        </Field>
      </div>
      <div className="form-row">
        <Field label={t('member.field.birthday')}>
          <input type="date" className={form.date_of_birth ? undefined : 'date-empty'} value={form.date_of_birth} onChange={(e) => setForm({ ...form, date_of_birth: e.target.value })} />
        </Field>
        <Field label={t('member.field.joined')}>
          <input type="date" className={form.joined_at ? undefined : 'date-empty'} value={form.joined_at} onChange={(e) => setForm({ ...form, joined_at: e.target.value })} />
        </Field>
      </div>
      <div className="form-row">
        <Field label={t('member.field.groupJoinedAt')}>
          <input
            type="date"
            className={form.group_joined_at ? undefined : 'date-empty'}
            value={form.group_joined_at}
            onChange={(e) => setForm({ ...form, group_joined_at: e.target.value })}
          />
        </Field>
      </div>
      <div className="form-row">
        <Field label={t('hall.label')}>
          <HallSelect value={form.hall_id} onChange={(id) => setForm({ ...form, hall_id: id })} />
        </Field>
        <Field label={t('members.field.group')}>
          <select value={form.group_id} onChange={(e) => changeGroup(e.target.value)}>
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
        {/* Only meaningful once a group is chosen — hidden rather than shown
            disabled, so there's nothing implying a rank that doesn't apply. */}
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
      <Field label={t('member.field.notes')}>
        <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} />
      </Field>
      <div className="hint" style={{ marginBottom: 6 }}>
        {form.group_id ? t('member.hint.leadership') : t('member.hint.noGroup')}
      </div>
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn" onClick={save} disabled={saving}>{saving ? t('common.saving') : t('common.save')}</button>
      </div>
    </Modal>
  );
}

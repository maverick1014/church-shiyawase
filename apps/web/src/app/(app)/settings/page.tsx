'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useFetch } from '@/lib/hooks';
import { useSortableRows } from '@/lib/sort';
import { api } from '@/lib/api';
import { usePageChrome, useMe } from '@/components/AppShell';
import {
  Avatar,
  BackBar,
  ChevronRightIcon,
  Combobox,
  EntityHeader,
  ErrorBanner,
  Field,
  HallSelect,
  Loading,
  MemberName,
  Modal,
  PageBar,
  PasswordInput,
  RoleBadge,
  RowChevron,
  SkeletonScreen,
  SkeletonTable,
  SortTh,
  Switch,
  useConfirm,
  useFormGuard,
  useToast,
} from '@/components/ui';
import { AccountRow, MemberRow } from '@/lib/types';
import {
  ACCOUNT_ROLE_OPTIONS,
  accountRoleClass,
  accountRoleKey,
  accountRoleOptionKey,
  accountStatusClass,
  accountStatusKey,
  churchDisplayRole,
  formatDateTime,
  memberRole,
  roleKey,
} from '@/lib/labels';
import { useT } from '@/lib/i18n';
import { AccountRole, AccountStatus, Language, LANGUAGES } from '@tog/shared';
import type { MessageKey } from '@/lib/i18n';

export default function SettingsPage() {
  const t = useT();
  const me = useMe();
  const router = useRouter();
  const isSuperAdmin = me.role === AccountRole.SuperAdmin;
  const toast = useToast();
  const accounts = useFetch<AccountRow[]>(isSuperAdmin ? '/accounts' : null);
  const members = useFetch<MemberRow[]>(isSuperAdmin ? '/members' : null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  usePageChrome({ title: t('settings.title') }, [t]);

  // Managing other people's logins is super_admin-only (the API says the same
  // for reads and writes). Everyone else who lands here by URL wants their own
  // account, so send them to 我的资料 rather than showing them a dead end —
  // this page used to render "only a super admin may manage users" plus a lone
  // change-password button, which was the profile page in miniature.
  useEffect(() => {
    if (!isSuperAdmin) router.replace('/profile');
  }, [isSuperAdmin, router]);

  const list = accounts.data ?? [];
  const selected = list.find((a) => a.id === detailId) ?? null;

  const { sorted: sortedAccounts, sortKey: acctSortKey, sortDir: acctSortDir, toggleSort: toggleAcctSort } =
    useSortableRows(
      list,
      (u, key) => {
        switch (key) {
          case 'role':
            return u.member ? t(roleKey(churchDisplayRole(u.member.church_role))) : undefined;
          case 'account_role':
            return t(accountRoleKey(u.account_role));
          case 'email':
            return u.email;
          case 'status':
            return t(accountStatusKey(u.status));
          case 'last_login':
            return u.last_sign_in_at ?? undefined;
          default:
            return u.member?.full_name;
        }
      },
      { key: 'name', dir: 'asc' },
    );

  const reload = () => {
    accounts.reload();
  };

  // Two states that used to share one line. A non-super-admin is not waiting
  // for anything — the redirect above is already in flight — so it keeps the
  // bounded one-line notice: painting the shape of an account list it will
  // never be shown would be a lie. Only the real wait, below, gets a skeleton.
  if (!isSuperAdmin) return <Loading />;

  if (selected) {
    return (
      <AccountDetail
        account={selected}
        onBack={() => setDetailId(null)}
        onSaved={() => {
          reload();
          toast(t('settings.toast.saved'));
        }}
        onDeleted={() => {
          setDetailId(null);
          reload();
          toast(t('settings.toast.deleted'));
        }}
      />
    );
  }

  return (
    <>
      <ErrorBanner message={accounts.error} />

      {/* One control: the single thing this page creates. What each permission
          role may do is now written into the 权限角色 dropdown itself (both the
          create modal and the account form), where it is read at the moment the
          role is chosen — a popover of reference text nobody opened is worse
          than a label on the control. "Change my password" used to sit here
          too, which wrapped the row onto two lines on a phone — and it was a
          duplicate: the shell's account menu has had it all along. */}
      <PageBar
        actions={<button className="btn" onClick={() => setAddOpen(true)}>{t('settings.add')}</button>}
      />

      {accounts.initialLoading ? (
        <SkeletonScreen>
          <SkeletonTable rows={6} columns={7} />
        </SkeletonScreen>
      ) : (
        <>
          {/* Desktop — table */}
          <div className="card only-desktop" style={{ padding: 6 }}>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <SortTh sortKey="name" activeKey={acctSortKey} dir={acctSortDir} onSort={toggleAcctSort}>{t('settings.col.account')}</SortTh>
                    <SortTh sortKey="role" activeKey={acctSortKey} dir={acctSortDir} onSort={toggleAcctSort}>{t('settings.col.churchRole')}</SortTh>
                    <SortTh sortKey="account_role" activeKey={acctSortKey} dir={acctSortDir} onSort={toggleAcctSort}>{t('settings.col.accountRole')}</SortTh>
                    <SortTh sortKey="email" activeKey={acctSortKey} dir={acctSortDir} onSort={toggleAcctSort}>{t('settings.col.email')}</SortTh>
                    <SortTh sortKey="status" activeKey={acctSortKey} dir={acctSortDir} onSort={toggleAcctSort}>{t('members.col.status')}</SortTh>
                    <SortTh sortKey="last_login" activeKey={acctSortKey} dir={acctSortDir} onSort={toggleAcctSort}>{t('settings.col.lastLogin')}</SortTh>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {sortedAccounts.map((u) => (
                    <tr key={u.id}>
                      <td><MemberName member={u.member} /></td>
                      <td>
                        {u.member ? <RoleBadge role={churchDisplayRole(u.member.church_role)} /> : '—'}
                      </td>
                      <td><span className={`badge ${accountRoleClass(u.account_role)}`}>{t(accountRoleKey(u.account_role))}</span></td>
                      <td className="muted">{u.email}</td>
                      <td><span className={`badge ${accountStatusClass(u.status)}`}>{t(accountStatusKey(u.status))}</span></td>
                      <td className="muted" style={{ whiteSpace: 'nowrap' }}>{u.last_sign_in_at ? formatDateTime(u.last_sign_in_at) : t('common.never')}</td>
                      <td style={{ textAlign: 'right' }}>
                        <RowChevron title={t('settings.manageAccount')} onClick={() => setDetailId(u.id)} />
                      </td>
                    </tr>
                  ))}
                  {sortedAccounts.length === 0 && (
                    <tr><td colSpan={7} className="empty-inline">{t('settings.empty')}</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Mobile — list tiles, same pattern as the member and group lists */}
          <div className="only-mobile">
            {sortedAccounts.map((u) => (
              <div key={u.id} className="mtile" onClick={() => setDetailId(u.id)}>
                <div className="mtile-row1">
                  <div className="flex items-center gap-8 flex-wrap" style={{ minWidth: 0 }}>
                    <MemberName member={u.member} />
                    {u.member && <RoleBadge role={churchDisplayRole(u.member.church_role)} />}
                  </div>
                  <span className="mtile-cta"><ChevronRightIcon /></span>
                </div>
                <div className="mtile-line">{u.email}</div>
                <div className="mtile-line flex items-center gap-8 flex-wrap">
                  <span className={`badge ${accountRoleClass(u.account_role)}`}>{t(accountRoleKey(u.account_role))}</span>
                  {/* Enabled is the normal state, so saying it on every tile is
                      noise on a phone where room is the scarce thing. Only the
                      exception is worth a badge. */}
                  {u.status !== AccountStatus.Active && (
                    <span className={`badge ${accountStatusClass(u.status)}`}>{t(accountStatusKey(u.status))}</span>
                  )}
                  <span>{u.last_sign_in_at ? formatDateTime(u.last_sign_in_at) : t('settings.neverSignedIn')}</span>
                </div>
              </div>
            ))}
            {sortedAccounts.length === 0 && (
              <div className="empty-inline">{t('settings.empty')}</div>
            )}
          </div>
        </>
      )}

      {addOpen && (
        <AddAccountModal
          members={members.data ?? []}
          existing={list}
          onClose={() => setAddOpen(false)}
          onSaved={() => {
            setAddOpen(false);
            reload();
            toast(t('settings.toast.created'));
          }}
        />
      )}
    </>
  );
}

/**
 * The 权限角色 picker, shared by the create modal and the account form so both
 * offer the same options with the same explanation (G4/G5). Each option reads
 * "role — what it may do"; the badge elsewhere keeps the bare role name.
 */
function AccountRoleField({ value, onChange }: { value: AccountRole; onChange: (r: AccountRole) => void }) {
  const t = useT();
  return (
    <Field label={t('settings.col.accountRole')}>
      <select value={value} onChange={(e) => onChange(e.target.value as AccountRole)}>
        {ACCOUNT_ROLE_OPTIONS.map((ar) => (
          <option key={ar} value={ar}>{t(accountRoleOptionKey(ar))}</option>
        ))}
      </select>
    </Field>
  );
}

function AccountDetail({
  account,
  onBack,
  onSaved,
  onDeleted,
}: {
  account: AccountRow;
  onBack: () => void;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const router = useRouter();
  const t = useT();
  // The login email is stored on the linked MEMBER and mirrored onto the
  // account server-side (`accountWrite`), so the two can never drift apart.
  // Editing it here writes the member first and lets the account re-derive it —
  // which is also how a member who had no email gets one without a detour to
  // the member page.
  const [email, setEmail] = useState(account.member?.email ?? account.email);
  const [role, setRole] = useState<AccountRole>(account.account_role);
  // null = full access (may see and manage every hall).
  const [hall, setHall] = useState<string | null>(account.hall_id ?? null);
  const [status, setStatus] = useState<AccountStatus>(account.status);
  const [language, setLanguage] = useState(account.language);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // A full-page form, not a modal: there is no ✕ to intercept, so the guard
  // here is the browser's own prompt for a refresh, re-baselined on save so a
  // form that saved and stayed open stops claiming it has unsaved work.
  const { markClean } = useFormGuard({ email, role, hall, status, language });
  const [pw, setPw] = useState('');
  const [pwBusy, setPwBusy] = useState(false);
  const toast = useToast();
  const confirm = useConfirm();

  const resetPassword = async () => {
    if (pw.length < 8) {
      setErr(t('password.err.tooShort'));
      return;
    }
    setPwBusy(true);
    setErr(null);
    try {
      await api.post(`/accounts/${account.id}/password`, { password: pw });
      setPw('');
      toast(
        t('settings.toast.passwordResetFor', {
          name: account.member?.full_name ?? t('settings.thisAccount'),
        }),
      );
    } catch (e) {
      setErr((e as Error).message);
      toast((e as Error).message, 'error');
    } finally {
      setPwBusy(false);
    }
  };

  const del = async () => {
    const ok = await confirm({
      title: t('settings.delete.title'),
      message: t('settings.delete.message', {
        name: account.member?.full_name ?? t('settings.thisAccount'),
      }),
      confirmText: t('settings.deleteAccount'),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.delete(`/accounts/${account.id}`);
      onDeleted();
    } catch (e) {
      setErr((e as Error).message);
      toast((e as Error).message, 'error');
    }
  };

  const save = async () => {
    const nextEmail = email.trim().toLowerCase();
    if (!nextEmail) {
      setErr(t('settings.err.email'));
      return;
    }
    setBusy(true);
    setErr(null);
    // The interface language is read once, when the page loads (`/auth/me`), so
    // every string already on screen stays in the old language until the page
    // is reloaded. Save first, then offer the reload — only when it changed, so
    // editing any other field never throws the page away.
    const languageChanged = language !== account.language;
    let saved = false;
    try {
      // Member first: the account PATCH below re-reads the member's email and
      // copies it onto the login, so writing them the other way round would
      // save the old address.
      if (account.member && nextEmail !== (account.member.email ?? '').toLowerCase()) {
        await api.patch(`/members/${account.member.id}`, { email: nextEmail });
      }
      await api.patch(`/accounts/${account.id}`, {
        account_role: role,
        hall_id: hall,
        status,
        language,
      });
      saved = true;
      // Saved and still on screen — re-baseline, or the browser would go on
      // warning about work that is already filed.
      markClean();
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
    if (!saved || !languageChanged) return;
    const reloadNow = await confirm({
      title: t('settings.language.reload.title'),
      message: t('settings.language.reload.message'),
      confirmText: t('settings.language.reload.confirm'),
      cancelText: t('settings.language.reload.later'),
    });
    if (reloadNow) window.location.reload();
    else toast(t('settings.language.reload.toast'));
  };

  return (
    <div className="page-narrow">
      {/* "View member profile" leaves this record and so belongs with back,
          not inside the record's own card. */}
      <BackBar
        onClick={onBack}
        actions={
          account.member && (
            <button className="btn ghost" onClick={() => router.push(`/members/${account.member!.id}`)}>
              {t('settings.viewMemberProfile')}
              <ChevronRightIcon size={16} />
            </button>
          )
        }
      />
      {err && <ErrorBanner message={err} />}

      <div className="card">
        <EntityHeader
          avatar={<Avatar name={account.member?.full_name ?? null} size="lg" />}
          title={<MemberName member={account.member} fallback={t('settings.thisAccount')} />}
          badges={
            <>
              <span className={`badge ${accountRoleClass(role)}`}>{t(accountRoleKey(role))}</span>
              {account.member && <RoleBadge role={churchDisplayRole(account.member.church_role)} />}
            </>
          }
          sub={t('settings.linkedTo', { email: account.email })}
        />

        <div className="grid g2" style={{ marginTop: 18 }}>
          <Field label={t('settings.emailFromMember')}>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t('settings.noEmailPlaceholder')}
              autoComplete="email"
            />
          </Field>
          <AccountRoleField value={role} onChange={setRole} />
          <Field label={t('hall.label')}>
            <HallSelect value={hall} onChange={setHall} allowAll allLabel={t('hall.unlimited')} />
          </Field>
          <div style={{ gridColumn: '1 / -1' }} className="flex-between" >
            <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 10, padding: '11px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{t('settings.accountStatus')}</div>
                <div className="muted" style={{ fontSize: 11.5 }}>{t('settings.accountStatusSub')}</div>
              </div>
              <Switch
                on={status === AccountStatus.Active}
                onToggle={() => setStatus(status === AccountStatus.Active ? AccountStatus.Disabled : AccountStatus.Active)}
              />
            </div>
          </div>
        </div>
      </div>

      <div className="grid g2 mt-16">
        <div className="card">
          <h3 style={{ marginBottom: 4 }}>{t('settings.security')}</h3>
          <div className="muted" style={{ fontSize: 11.5, marginBottom: 12 }}>{t('settings.resetHint')}</div>
          <Field label={t('settings.newPassword')}>
            <PasswordInput value={pw} onChange={setPw} placeholder={t('settings.passwordHint')} autoComplete="new-password" />
          </Field>
          <button className="btn ghost block" onClick={resetPassword} disabled={pwBusy || pw.length < 8}>
            {pwBusy ? t('settings.resetting') : t('settings.resetPassword')}
          </button>
        </div>

        <div className="card">
          <h3 style={{ marginBottom: 14 }}>{t('settings.preferences')}</h3>
          <Field label={t('settings.language')}>
            {/* The options come from the shipped dictionaries, so a language can
                never be selected that the app has no translations for. */}
            <select value={language} onChange={(e) => setLanguage(e.target.value as Language)}>
              {LANGUAGES.map((code) => (
                <option key={code} value={code}>{t(`language.${code}` as MessageKey)}</option>
              ))}
            </select>
          </Field>
        </div>
      </div>

      <div className="card flex-between flex-wrap mt-16">
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--crit)' }}>{t('settings.deleteAccount')}</div>
          <div className="muted" style={{ fontSize: 11.5 }}>{t('settings.deleteAccountSub')}</div>
        </div>
        <button className="btn danger" onClick={del}>{t('settings.deleteAccount')}</button>
      </div>

      {/* Pinned to the foot of the viewport (`.detail-footer` in globals.css),
          so Save is reachable from anywhere in a long form instead of only
          after scrolling back down. It stays in the flow — sticky, not fixed —
          so it can never sit on top of the last row of content. */}
      <div className="detail-footer">
        <button className="btn ghost" onClick={onBack}>{t('common.cancel')}</button>
        <button className="btn" onClick={save} disabled={busy}>{busy ? t('common.saving') : t('settings.saveAccount')}</button>
      </div>
    </div>
  );
}

function AddAccountModal({
  members,
  existing,
  onClose,
  onSaved,
}: {
  members: MemberRow[];
  existing: AccountRow[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const takenMembers = new Set(existing.map((a) => a.member_id));
  const [memberId, setMemberId] = useState('');
  // The login email is the member's own email. It is editable here so a member
  // who has none can still be given an account in one go — it is written onto
  // the member below, and the account derives it from there server-side.
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<AccountRole>(AccountRole.Coworker);
  // null = full access (every hall).
  const [hall, setHall] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Asks before ✕ or Cancel discards this, and arms the browser's prompt for
  // a refresh. The typed password especially: it is shown once and never again.
  const { close } = useFormGuard({ memberId, email, role, hall, password }, onClose);

  const selectedMember = members.find((m) => m.id === memberId) ?? null;

  const pickMember = (id: string) => {
    setMemberId(id);
    setEmail(members.find((m) => m.id === id)?.email ?? '');
  };

  const save = async () => {
    if (!memberId) {
      setErr(t('settings.err.member'));
      return;
    }
    const nextEmail = email.trim().toLowerCase();
    if (!nextEmail) {
      setErr(t('settings.err.email'));
      return;
    }
    if (password.length < 8) {
      setErr(t('settings.err.password'));
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      // Member first — the account's login email is read back off the member
      // when it is created, so this is what unblocks a member with no email.
      if (nextEmail !== (selectedMember?.email ?? '').toLowerCase()) {
        await api.patch(`/members/${memberId}`, { email: nextEmail });
      }
      await api.post('/accounts', {
        member_id: memberId,
        account_role: role,
        hall_id: hall,
        password,
      });
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={t('settings.new.title')} onClose={close}>
      {err && <ErrorBanner message={err} />}
      <Field label={t('settings.linkMember')}>
        {/* Type-to-search, like every other member field (rule G4) — members
            who already have an account are simply not in the list. */}
        <Combobox
          value={memberId}
          onChange={pickMember}
          options={members
            .filter((m) => !takenMembers.has(m.id))
            .map((m) => ({
              value: m.id,
              label: m.full_name,
              sub: m.english_name,
              hint: t(roleKey(memberRole(m))),
            }))}
          placeholder={t('settings.chooseMember')}
          ariaLabel={t('settings.linkMember')}
        />
      </Field>
      <div className="form-row">
        <Field label={t('settings.emailFromMember')}>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t('settings.noEmailPlaceholder')}
            autoComplete="email"
          />
        </Field>
        <AccountRoleField value={role} onChange={setRole} />
      </div>
      <Field label={t('hall.label')}>
        <HallSelect value={hall} onChange={setHall} allowAll allLabel={t('hall.unlimited')} />
      </Field>
      <Field label={t('settings.initialPassword')}>
        <PasswordInput value={password} onChange={setPassword} placeholder={t('settings.initialPasswordHint')} autoComplete="new-password" />
      </Field>
      <div className="modal-actions">
        <button className="btn ghost" onClick={close}>{t('common.cancel')}</button>
        <button className="btn" onClick={save} disabled={saving || !memberId || !email.trim()}>{saving ? t('common.saving') : t('settings.create')}</button>
      </div>
    </Modal>
  );
}

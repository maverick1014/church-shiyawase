'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useFetch } from '@/lib/hooks';
import { useSortableRows } from '@/lib/sort';
import { api } from '@/lib/api';
import { usePageChrome, useMe } from '@/components/AppShell';
import {
  Avatar,
  ChevronRightIcon,
  ErrorBanner,
  Field,
  HallSelect,
  InfoPopover,
  Loading,
  Modal,
  PasswordInput,
  RoleBadge,
  RowChevron,
  SortTh,
  Switch,
  useConfirm,
  useToast,
} from '@/components/ui';
import { ChangePasswordModal } from '@/components/ChangePasswordModal';
import { AccountRow, MemberRow } from '@/lib/types';
import {
  ACCOUNT_ROLE_OPTIONS,
  ACCOUNT_ROLE_PERMISSIONS,
  ACCOUNT_ROLE_ZH,
  accountRoleClass,
  accountStatusClass,
  accountStatusLabel,
  churchRoleZh,
  formatDateTime,
  memberRoleZh,
} from '@/lib/labels';
import { AccountRole, AccountStatus, ACCOUNT_ROLE_LABELS } from '@tog/shared';

export default function SettingsPage() {
  const me = useMe();
  const isSuperAdmin = me.role === AccountRole.SuperAdmin;
  const toast = useToast();
  const accounts = useFetch<AccountRow[]>(isSuperAdmin ? '/accounts' : null);
  const members = useFetch<MemberRow[]>(isSuperAdmin ? '/members' : null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [myPwOpen, setMyPwOpen] = useState(false);

  usePageChrome({
    title: '用户管理',
    subtitle: '登录账户 · 权限角色 · 安全与偏好',
    action: (
      <>
        <button className="btn ghost" onClick={() => setMyPwOpen(true)}>
          修改我的密码
        </button>
        <button className="btn" onClick={() => setAddOpen(true)}>
          ＋ 新建账户
        </button>
      </>
    ),
  });

  const list = accounts.data ?? [];
  const selected = list.find((a) => a.id === detailId) ?? null;

  const { sorted: sortedAccounts, sortKey: acctSortKey, sortDir: acctSortDir, toggleSort: toggleAcctSort } =
    useSortableRows(
      list,
      (u, key) => {
        switch (key) {
          case 'role':
            return u.member ? churchRoleZh(u.member.church_role) : undefined;
          case 'account_role':
            return ACCOUNT_ROLE_ZH[u.account_role];
          case 'email':
            return u.email;
          case 'status':
            return accountStatusLabel(u.status);
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

  // 用户管理 is super_admin-only; others may still change their own password.
  if (!isSuperAdmin) {
    return (
      <>
        <div className="empty">仅超级管理员可访问用户管理。</div>
        <div style={{ textAlign: 'center', marginTop: 12 }}>
          <button className="btn ghost" onClick={() => setMyPwOpen(true)}>修改我的密码</button>
        </div>
        {myPwOpen && (
          <ChangePasswordModal
            onClose={() => setMyPwOpen(false)}
            onSaved={() => {
              setMyPwOpen(false);
              toast('密码已更新');
            }}
          />
        )}
      </>
    );
  }

  if (accounts.initialLoading) return <Loading />;

  if (selected) {
    return (
      <AccountDetail
        account={selected}
        onBack={() => setDetailId(null)}
        onSaved={() => {
          reload();
          toast('已保存账户设置');
        }}
        onDeleted={() => {
          setDetailId(null);
          reload();
          toast('已删除账户');
        }}
      />
    );
  }

  return (
    <>
      <ErrorBanner message={accounts.error} />

      {/* The permission matrix is reference material — behind an icon so it
          doesn't push the account list itself below the fold. */}
      <div className="filter-bar">
        <span className="spacer" />
        <InfoPopover label="权限说明">
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>权限说明</div>
          {ACCOUNT_ROLE_OPTIONS.map((r) => (
            <div key={r} style={{ marginBottom: 12 }}>
              <span className={`badge ${accountRoleClass(r)}`}>{ACCOUNT_ROLE_ZH[r]}</span>
              <ul style={{ margin: '7px 0 0', paddingLeft: 16, fontSize: 12, color: 'var(--muted)', lineHeight: 1.7 }}>
                {ACCOUNT_ROLE_PERMISSIONS[r].map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            </div>
          ))}
        </InfoPopover>
      </div>

      {/* Desktop — table */}
      <div className="card only-desktop" style={{ padding: 6 }}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <SortTh sortKey="name" activeKey={acctSortKey} dir={acctSortDir} onSort={toggleAcctSort}>账户 · 关联成员</SortTh>
                <SortTh sortKey="role" activeKey={acctSortKey} dir={acctSortDir} onSort={toggleAcctSort}>教会身份</SortTh>
                <SortTh sortKey="account_role" activeKey={acctSortKey} dir={acctSortDir} onSort={toggleAcctSort}>权限角色</SortTh>
                <SortTh sortKey="email" activeKey={acctSortKey} dir={acctSortDir} onSort={toggleAcctSort}>登录邮箱</SortTh>
                <SortTh sortKey="status" activeKey={acctSortKey} dir={acctSortDir} onSort={toggleAcctSort}>状态</SortTh>
                <SortTh sortKey="last_login" activeKey={acctSortKey} dir={acctSortDir} onSort={toggleAcctSort}>最近登录</SortTh>
                <th />
              </tr>
            </thead>
            <tbody>
              {sortedAccounts.map((u) => {
                const role = u.member ? churchRoleZh(u.member.church_role) : '—';
                return (
                  <tr key={u.id}>
                    <td><strong>{u.member?.full_name ?? '—'}</strong></td>
                    <td>
                      <RoleBadge role={role} />
                    </td>
                    <td><span className={`badge ${accountRoleClass(u.account_role)}`}>{ACCOUNT_ROLE_ZH[u.account_role]}</span></td>
                    <td className="muted">{u.email}</td>
                    <td><span className={`badge ${accountStatusClass(u.status)}`}>{accountStatusLabel(u.status)}</span></td>
                    <td className="muted" style={{ whiteSpace: 'nowrap' }}>{u.last_sign_in_at ? formatDateTime(u.last_sign_in_at) : '从未'}</td>
                    <td style={{ textAlign: 'right' }}>
                      <RowChevron title="管理账户" onClick={() => setDetailId(u.id)} />
                    </td>
                  </tr>
                );
              })}
              {sortedAccounts.length === 0 && (
                <tr><td colSpan={7} className="empty-inline">尚无账户。</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Mobile — list tiles, same pattern as 成员目录 / 小组管理 */}
      <div className="only-mobile">
        {sortedAccounts.map((u) => {
          const role = u.member ? churchRoleZh(u.member.church_role) : '—';
          return (
            <div key={u.id} className="mtile" onClick={() => setDetailId(u.id)}>
              <div className="mtile-row1">
                <div className="flex items-center gap-8 flex-wrap" style={{ minWidth: 0 }}>
                  <strong>{u.member?.full_name ?? '—'}</strong>
                  <RoleBadge role={role} />
                </div>
                <span className="mtile-cta"><ChevronRightIcon /></span>
              </div>
              <div className="mtile-line">{u.email}</div>
              <div className="mtile-line flex items-center gap-8 flex-wrap">
                <span className={`badge ${accountRoleClass(u.account_role)}`}>{ACCOUNT_ROLE_ZH[u.account_role]}</span>
                <span className={`badge ${accountStatusClass(u.status)}`}>{accountStatusLabel(u.status)}</span>
                <span>{u.last_sign_in_at ? formatDateTime(u.last_sign_in_at) : '从未登录'}</span>
              </div>
            </div>
          );
        })}
        {sortedAccounts.length === 0 && (
          <div className="empty-inline">尚无账户。</div>
        )}
      </div>

      {addOpen && (
        <AddAccountModal
          members={members.data ?? []}
          existing={list}
          onClose={() => setAddOpen(false)}
          onSaved={() => {
            setAddOpen(false);
            reload();
            toast('已新建账户');
          }}
        />
      )}

      {myPwOpen && (
        <ChangePasswordModal
          onClose={() => setMyPwOpen(false)}
          onSaved={() => {
            setMyPwOpen(false);
            toast('密码已更新');
          }}
        />
      )}
    </>
  );
}

function NotifyRow({ title, sub, on, set }: { title: string; sub: string; on: boolean; set: (v: boolean) => void }) {
  return (
    <div className="flex-between" style={{ padding: '11px 0', borderBottom: '1px solid var(--border)' }}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{title}</div>
        <div className="muted" style={{ fontSize: 11.5 }}>{sub}</div>
      </div>
      <Switch on={on} onToggle={() => set(!on)} />
    </div>
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
  // Login email always follows the linked member's own profile — never
  // independently editable — so the two can never drift apart.
  const email = account.member?.email ?? account.email;
  const [role, setRole] = useState<AccountRole>(account.account_role);
  // null = 全堂权限 (may see and manage every hall).
  const [hall, setHall] = useState<string | null>(account.hall_id ?? null);
  const [status, setStatus] = useState<AccountStatus>(account.status);
  const [language, setLanguage] = useState(account.language);
  const [nDisc, setNDisc] = useState(account.notify_discipleship);
  const [nWeekly, setNWeekly] = useState(account.notify_weekly);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pw, setPw] = useState('');
  const [pwBusy, setPwBusy] = useState(false);
  const toast = useToast();
  const confirm = useConfirm();

  const memberRole = account.member ? churchRoleZh(account.member.church_role) : '—';

  const resetPassword = async () => {
    if (pw.length < 8) {
      setErr('新密码至少 8 位');
      return;
    }
    setPwBusy(true);
    setErr(null);
    try {
      await api.post(`/accounts/${account.id}/password`, { password: pw });
      setPw('');
      toast(`已为 ${account.member?.full_name ?? '该账户'} 重设密码`);
    } catch (e) {
      setErr((e as Error).message);
      toast((e as Error).message, 'error');
    } finally {
      setPwBusy(false);
    }
  };

  const del = async () => {
    const ok = await confirm({
      title: '删除登录账户',
      message: `删除 ${account.member?.full_name ?? '该成员'} 的登录账户？其成员档案会保留。`,
      confirmText: '删除账户',
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
    setBusy(true);
    setErr(null);
    try {
      await api.patch(`/accounts/${account.id}`, {
        account_role: role,
        hall_id: hall,
        status,
        language,
        notify_discipleship: nDisc,
        notify_weekly: nWeekly,
      });
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ maxWidth: 720 }}>
      <button className="back-btn" onClick={onBack}>‹ 返回用户列表</button>
      {err && <ErrorBanner message={err} />}

      <div className="card">
        <div className="flex items-center gap-12 flex-wrap">
          <Avatar name={account.member?.full_name ?? null} size="lg" />
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="flex items-center gap-10 flex-wrap">
              <h2 style={{ margin: 0, fontSize: 20 }} className="serif">{account.member?.full_name}</h2>
              <span className={`badge ${accountRoleClass(role)}`}>{ACCOUNT_ROLE_ZH[role]}</span>
              <RoleBadge role={memberRole} />
            </div>
            <div className="muted" style={{ fontSize: 12.5, marginTop: 3 }}>账户已关联成员档案 · {account.email}</div>
          </div>
          {account.member && (
            <button className="btn ghost" onClick={() => router.push(`/members/${account.member!.id}`)}>查看成员档案 →</button>
          )}
        </div>

        <div className="grid g2" style={{ marginTop: 18 }}>
          <Field label="登录邮箱（来自成员资料）">
            <input value={email} readOnly disabled style={{ color: 'var(--muted)' }} />
          </Field>
          <Field label="权限角色">
            <select value={role} onChange={(e) => setRole(e.target.value as AccountRole)}>
              {ACCOUNT_ROLE_OPTIONS.map((r) => (
                <option key={r} value={r}>{ACCOUNT_ROLE_LABELS[r]}</option>
              ))}
            </select>
          </Field>
          <Field label="所属堂会">
            <HallSelect value={hall} onChange={setHall} allowAll allLabel="全堂会（不限）" />
          </Field>
          <div className="hint" style={{ gridColumn: '1 / -1' }}>
            💡 选定某个堂会后，该账户只能查看与管理该堂的成员、小组、聚会与培训；「全堂会」则不限。
          </div>
          <div style={{ gridColumn: '1 / -1' }} className="flex-between" >
            <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 10, padding: '11px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>账户状态</div>
                <div className="muted" style={{ fontSize: 11.5 }}>停用后该成员无法登录后台</div>
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
          <h3 style={{ marginBottom: 4 }}>安全 · 重设登录密码</h3>
          <div className="muted" style={{ fontSize: 11.5, marginBottom: 12 }}>
            仅超级管理员可为其他账户直接重设密码；无需知道旧密码。
          </div>
          <Field label="新密码">
            <PasswordInput value={pw} onChange={setPw} placeholder="至少 8 位" autoComplete="new-password" />
          </Field>
          <button className="btn ghost block" onClick={resetPassword} disabled={pwBusy || pw.length < 8}>
            {pwBusy ? '重设中…' : '重设该账户密码'}
          </button>
        </div>

        <div className="card">
          <h3 style={{ marginBottom: 14 }}>偏好</h3>
          <Field label="界面语言">
            <select value={language} onChange={(e) => setLanguage(e.target.value)}>
              <option value="zh-CN">简体中文</option>
              <option value="zh-TW">繁體中文</option>
              <option value="en">English</option>
              <option value="ms">Bahasa Melayu</option>
            </select>
          </Field>
        </div>
      </div>

      {/* 通知 (notifications) hidden until email/push delivery is actually
          implemented — the toggles didn't send anything, just stored a flag. */}

      <div className="card flex-between flex-wrap mt-16">
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--crit)' }}>删除账户</div>
          <div className="muted" style={{ fontSize: 11.5 }}>移除此登录账户 · 不会删除其成员档案</div>
        </div>
        <button className="btn danger" onClick={del}>删除账户</button>
      </div>

      <div className="flex-between flex-wrap mt-16">
        <button className="btn ghost" onClick={onBack}>取消</button>
        <button className="btn" onClick={save} disabled={busy}>{busy ? '保存中…' : '保存账户设置'}</button>
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
  const toast = useToast();
  const takenMembers = new Set(existing.map((a) => a.member_id));
  const [memberId, setMemberId] = useState('');
  const [role, setRole] = useState<AccountRole>(AccountRole.Coworker);
  // null = 全堂权限.
  const [hall, setHall] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const selectedMember = members.find((m) => m.id === memberId) ?? null;
  // The login email always follows the member's own profile — never a
  // separately typed value — so the two can never drift apart.
  const email = selectedMember?.email ?? '';

  const save = async () => {
    if (!memberId) {
      setErr('请选择成员');
      return;
    }
    if (!email) {
      setErr('该成员尚未填写邮箱，请先在成员资料中补上邮箱');
      return;
    }
    if (password.length < 8) {
      setErr('请设定至少 8 位的初始密码');
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      await api.post('/accounts', {
        member_id: memberId,
        email,
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
    <Modal title="新建账户" onClose={onClose}>
      {err && <ErrorBanner message={err} />}
      <p className="muted" style={{ margin: '0 0 14px', fontSize: 12.5, lineHeight: 1.6 }}>
        登录账户必须<strong style={{ color: 'var(--ink)' }}>关联一位成员</strong>，登录邮箱直接沿用该成员资料里的邮箱。
      </p>
      <Field label="关联成员（已有账户者不显示）">
        <select value={memberId} onChange={(e) => setMemberId(e.target.value)}>
          <option value="">选择成员…</option>
          {members
            .filter((m) => !takenMembers.has(m.id))
            .map((m) => (
              <option key={m.id} value={m.id}>{m.full_name}（{memberRoleZh(m)}）</option>
            ))}
        </select>
      </Field>
      <div className="form-row">
        <Field label="登录邮箱（来自成员资料）">
          <input value={email} readOnly disabled placeholder="该成员尚未填写邮箱" style={{ color: 'var(--muted)' }} />
        </Field>
        <Field label="权限角色">
          <select value={role} onChange={(e) => setRole(e.target.value as AccountRole)}>
            {ACCOUNT_ROLE_OPTIONS.map((r) => (
              <option key={r} value={r}>{ACCOUNT_ROLE_LABELS[r]}</option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="所属堂会">
        <HallSelect value={hall} onChange={setHall} allowAll allLabel="全堂会（不限）" />
      </Field>
      {memberId && !email && (
        <div className="hint" style={{ marginBottom: 14 }}>
          ⚠️ 该成员尚未填写邮箱，请先到「成员目录」为其补上邮箱，再回来建立登录账户。
        </div>
      )}
      <Field label="初始密码">
        <PasswordInput value={password} onChange={setPassword} placeholder="至少 8 位，可稍后由用户自行修改" autoComplete="new-password" />
      </Field>
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>取消</button>
        <button className="btn" onClick={save} disabled={saving || !memberId || !email}>{saving ? '保存中…' : '创建账户'}</button>
      </div>
    </Modal>
  );
}

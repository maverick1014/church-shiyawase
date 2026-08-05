'use client';

import { createContext, ReactNode, useContext, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ConfirmProvider, ToastProvider, useConfirm, useToast } from './ui';
import { ChangePasswordModal } from './ChangePasswordModal';
import { BrandLogo } from './BrandLogo';
import { initialOf } from '@/lib/labels';
import { HallContext } from '@/lib/hall';
import { HallRow } from '@/lib/types';
import { ACCOUNT_ROLE_LABELS, AccountRole } from '@tog/shared';

type Me = { name: string; role: string; member: string | null; hall: string | null };

/* -------------------------------------------------------------------------
 * Current-user context — pages read the session role to gate UI (rule G2).
 * ---------------------------------------------------------------------- */
const MeContext = createContext<Me | null>(null);

/** The logged-in account (name, role, member, hall). Only valid inside AppShell. */
export function useMe(): Me {
  return useContext(MeContext) ?? { name: '', role: '', member: null, hall: null };
}

// Hall scope lives in lib/hall.tsx so useFetch can read it without importing
// the shell. Re-exported here since pages already import from AppShell.
export { useHallScope } from '@/lib/hall';

/* -------------------------------------------------------------------------
 * Page chrome context — pages set the topbar title / subtitle / action.
 * ---------------------------------------------------------------------- */
type Chrome = { title: string; subtitle?: string; action?: ReactNode };
const ChromeContext = createContext<(c: Chrome) => void>(() => {});

export function usePageChrome(chrome: Chrome, deps: unknown[] = []) {
  const set = useContext(ChromeContext);
  useEffect(() => {
    set(chrome);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/* -------------------------------------------------------------------------
 * Navigation model
 * ---------------------------------------------------------------------- */
type NavItem = { href: string; label: string; icon: string; role?: AccountRole };
const NAV: { section: string; items: NavItem[] }[] = [
  {
    section: '概览',
    items: [{ href: '/', label: '仪表盘', icon: '◎' }],
  },
  {
    section: '牧养',
    items: [
      { href: '/members', label: '成员目录', icon: '👥' },
      { href: '/groups', label: '小组管理', icon: '🔗' },
      { href: '/events', label: '聚会与出席', icon: '📅' },
    ],
  },
  {
    section: '造就',
    items: [
      { href: '/trainings', label: '培训课程', icon: '📖' },
      { href: '/discipleship', label: '四十天守望', icon: '✝' },
    ],
  },
  {
    // 用户管理 is super_admin-only (matches the API gate on /accounts).
    section: '系统',
    items: [{ href: '/settings', label: '用户管理', icon: '⚙', role: AccountRole.SuperAdmin }],
  },
];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [navOpen, setNavOpen] = useState(false);
  const [chrome, setChrome] = useState<Chrome>({ title: '仪表盘' });
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [halls, setHalls] = useState<HallRow[]>([]);
  // '' = 全部堂会. A single-hall account is pinned to its own hall below.
  const [hallId, setHallId] = useState('');

  // Close the mobile drawer on navigation.
  useEffect(() => {
    setNavOpen(false);
  }, [pathname]);

  // Require a valid session — otherwise send the user to the login page.
  useEffect(() => {
    let alive = true;
    fetch('/api/auth/me')
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((u: Me) => {
        if (!alive) return;
        setMe(u);
        // A hall-scoped account always views its own hall; the switcher is
        // hidden for them (the server enforces the same scope regardless).
        if (u.hall) setHallId(u.hall);
        return fetch('/api/halls')
          .then((r) => (r.ok ? r.json() : []))
          .then((hs: HallRow[]) => {
            if (alive) setHalls(hs);
          })
          .catch(() => {});
      })
      .catch(() => {
        window.location.href = '/login';
      });
    return () => {
      alive = false;
    };
  }, []);

  const isActive = (href: string) =>
    href === '/' ? pathname === '/' : pathname.startsWith(href);

  // Hall switcher — only for accounts that span more than one hall; a
  // hall-scoped account has nothing to switch to. Rendered in the topbar on
  // desktop and again in the content actions on mobile (where .topbar-actions
  // is hidden), so it never disappears on a phone.
  const hallSwitcher =
    me && !me.hall && halls.length > 1 ? (
      <select
        className="sm"
        value={hallId}
        onChange={(e) => setHallId(e.target.value)}
        title="切换查看的堂会"
        style={{ width: 'auto' }}
      >
        <option value="">全部堂会</option>
        {halls.map((h) => (
          <option key={h.id} value={h.id}>{h.name}</option>
        ))}
      </select>
    ) : null;

  if (!me) {
    return (
      <div className="loading" style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>
        加载中…
      </div>
    );
  }

  return (
    <MeContext.Provider value={me}>
    <HallContext.Provider value={{ halls, hallId, setHallId, locked: !!me.hall }}>
    <ConfirmProvider>
    <ToastProvider>
      <ChromeContext.Provider value={setChrome}>
        <div className={`app-shell ${navOpen ? 'nav-open' : ''}`}>
          <aside className="sidebar">
            <div className="brand-head">
              <div className="brand-mark">
                <BrandLogo size={34} />
              </div>
              <div className="brand-name">
                主恩堂
                <small>
                  TABERNACLE OF GRACE
                </small>
              </div>
            </div>

            {NAV.map((group) => {
              const items = group.items.filter((it) => !it.role || it.role === me.role);
              if (items.length === 0) return null;
              return (
                <div key={group.section}>
                  <div className="nav-section">{group.section}</div>
                  {items.map((item) => (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={`nav-link ${isActive(item.href) ? 'active' : ''}`}
                    >
                      <span className="ico">{item.icon}</span> {item.label}
                    </Link>
                  ))}
                </div>
              );
            })}

            <div className="grow" />
            <NavUser me={me} />
          </aside>

          <div className="scrim" onClick={() => setNavOpen(false)} />

          <div className="main">
            <div className="topbar">
              <div className="flex items-center gap-12" style={{ minWidth: 0 }}>
                <button
                  className="hamburger"
                  onClick={() => setNavOpen((o) => !o)}
                  aria-label="菜单"
                >
                  ☰
                </button>
                <div>
                  <h1>{chrome.title}</h1>
                  {chrome.subtitle && <div className="sub">{chrome.subtitle}</div>}
                </div>
              </div>
              {(hallSwitcher || chrome.action) && (
                <div className="flex items-center gap-10 topbar-actions">
                  {hallSwitcher}
                  {chrome.action}
                </div>
              )}
            </div>

            <div className="content view-anim" key={pathname}>
              {(hallSwitcher || chrome.action) && (
                <div className="content-actions">
                  {hallSwitcher}
                  {chrome.action}
                </div>
              )}
              {children}
            </div>
          </div>
        </div>
      </ChromeContext.Provider>
    </ToastProvider>
    </ConfirmProvider>
    </HallContext.Provider>
    </MeContext.Provider>
  );
}

function NavUser({ me }: { me: Me }) {
  const confirm = useConfirm();
  const toast = useToast();
  const [menuOpen, setMenuOpen] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);

  const logout = async () => {
    setMenuOpen(false);
    const ok = await confirm({
      title: '退出登录',
      message: '确定要退出当前账户吗？',
      confirmText: '退出登录',
      danger: true,
    });
    if (!ok) return;
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
      window.location.href = '/login';
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <div style={{ position: 'relative' }}>
      {menuOpen && (
        <div className="nav-user-menu">
          <button onClick={() => { setMenuOpen(false); setPwOpen(true); }}>🔑 修改我的密码</button>
          <button onClick={logout}>↩ 退出登录</button>
        </div>
      )}
      <div className="nav-user" onClick={() => setMenuOpen((o) => !o)} title="账户菜单" style={{ cursor: 'pointer' }}>
        <div className="avatar">{initialOf(me.name)}</div>
        <div className="who">
          {me.name}
          <small>{ACCOUNT_ROLE_LABELS[me.role as AccountRole] ?? me.role} · 账户菜单</small>
        </div>
      </div>
      {pwOpen && (
        <ChangePasswordModal
          onClose={() => setPwOpen(false)}
          onSaved={() => {
            setPwOpen(false);
            toast('密码已更新');
          }}
        />
      )}
    </div>
  );
}

'use client';

import { createContext, ReactNode, useContext, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ConfirmProvider, ToastProvider, useConfirm, useToast } from './ui';
import { ChangePasswordModal } from './ChangePasswordModal';
import { BrandLogo } from './BrandLogo';
import { accountRoleKey, initialOf } from '@/lib/labels';
import { HallContext } from '@/lib/hall';
import { I18nProvider, useT } from '@/lib/i18n';
import type { MessageKey } from '@/lib/i18n';
import { HallRow } from '@/lib/types';
import { AccountRole, Language } from '@tog/shared';

type Me = {
  name: string;
  role: string;
  member: string | null;
  hall: string | null;
  language: Language;
};

/* -------------------------------------------------------------------------
 * Current-user context — pages read the session role to gate UI (rule G2).
 * ---------------------------------------------------------------------- */
const MeContext = createContext<Me | null>(null);

/** The logged-in account (name, role, member, hall). Only valid inside AppShell. */
export function useMe(): Me {
  return (
    useContext(MeContext) ?? { name: '', role: '', member: null, hall: null, language: 'en' }
  );
}

// Hall scope lives in lib/hall.tsx so useFetch can read it without importing
// the shell. Re-exported here since pages already import from AppShell.
export { useHallScope } from '@/lib/hall';

/* -------------------------------------------------------------------------
 * Page chrome context — pages set the topbar title / action.
 * ---------------------------------------------------------------------- */
type Chrome = { title: string; action?: ReactNode };
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
type NavItem = { href: string; label: MessageKey; icon: string; role?: AccountRole };
const NAV: { section: MessageKey; items: NavItem[] }[] = [
  {
    section: 'nav.section.overview',
    items: [{ href: '/', label: 'nav.dashboard', icon: '◎' }],
  },
  {
    section: 'nav.section.care',
    items: [
      { href: '/members', label: 'nav.members', icon: '👥' },
      { href: '/groups', label: 'nav.groups', icon: '🔗' },
      { href: '/events', label: 'nav.events', icon: '📅' },
    ],
  },
  {
    section: 'nav.section.growth',
    items: [
      { href: '/trainings', label: 'nav.trainings', icon: '📖' },
      { href: '/discipleship', label: 'nav.discipleship', icon: '✝' },
    ],
  },
  {
    // User management is super_admin-only (matches the API gate on /accounts).
    section: 'nav.section.system',
    items: [{ href: '/settings', label: 'nav.settings', icon: '⚙', role: AccountRole.SuperAdmin }],
  },
];

/**
 * The shell owns the session, so it also owns the interface language: it hands
 * `me.language` to the i18n provider before rendering anything translated.
 * While the session is still loading, the provider falls back to English.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  return (
    <I18nProvider lang={me?.language}>
      <Shell me={me} setMe={setMe}>{children}</Shell>
    </I18nProvider>
  );
}

function Shell({
  me,
  setMe,
  children,
}: {
  me: Me | null | undefined;
  setMe: (m: Me) => void;
  children: ReactNode;
}) {
  const t = useT();
  const pathname = usePathname();
  const [navOpen, setNavOpen] = useState(false);
  const [chrome, setChrome] = useState<Chrome>({ title: '' });
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isActive = (href: string) =>
    href === '/' ? pathname === '/' : pathname.startsWith(href);

  // Hall switcher — only for accounts that span more than one hall; a
  // hall-scoped account has nothing to switch to.
  //
  // It belongs to the shell, not to the page, so it lives at the top right of
  // the header on desktop and inside the nav drawer on phones — never mixed in
  // with the page's own action buttons, which is what made every list page lay
  // its top row out differently.
  const hallSwitcher =
    me && !me.hall && halls.length > 1 ? (
      <select
        className="sm"
        value={hallId}
        onChange={(e) => setHallId(e.target.value)}
        title={t('hall.switchTitle')}
        style={{ width: 'auto' }}
      >
        <option value="">{t('hall.all')}</option>
        {halls.map((h) => (
          <option key={h.id} value={h.id}>{h.name}</option>
        ))}
      </select>
    ) : null;

  if (!me) {
    return (
      <div className="loading" style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>
        {t('common.loading')}
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
              <div className="brand-name">{t('login.title')}</div>
            </div>

            {/* Phones only: the topbar's actions are hidden below 820px, so the
                congregation switcher moves into the drawer, above the nav. */}
            {hallSwitcher && (
              <div className="nav-hall">
                <div className="nav-section" style={{ padding: '0 12px 6px' }}>{t('hall.label')}</div>
                {hallSwitcher}
              </div>
            )}

            {NAV.map((group) => {
              const items = group.items.filter((it) => !it.role || it.role === me.role);
              if (items.length === 0) return null;
              return (
                <div key={group.section}>
                  <div className="nav-section">{t(group.section)}</div>
                  {items.map((item) => (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={`nav-link ${isActive(item.href) ? 'active' : ''}`}
                    >
                      <span className="ico">{item.icon}</span> {t(item.label)}
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
                  aria-label={t('nav.menu')}
                >
                  ☰
                </button>
                <h1>{chrome.title}</h1>
              </div>
              {(chrome.action || hallSwitcher) && (
                <div className="flex items-center gap-10 topbar-actions">
                  {chrome.action}
                  {hallSwitcher}
                </div>
              )}
            </div>

            <div className="content view-anim" key={pathname}>
              {chrome.action && <div className="content-actions">{chrome.action}</div>}
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
  const t = useT();
  const confirm = useConfirm();
  const toast = useToast();
  const [menuOpen, setMenuOpen] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);

  const logout = async () => {
    setMenuOpen(false);
    const ok = await confirm({
      title: t('nav.logout.confirmTitle'),
      message: t('nav.logout.confirmMessage'),
      confirmText: t('nav.logout'),
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
          <button onClick={() => { setMenuOpen(false); setPwOpen(true); }}>🔑 {t('nav.changePassword')}</button>
          <button onClick={logout}>↩ {t('nav.logout')}</button>
        </div>
      )}
      <div className="nav-user" onClick={() => setMenuOpen((o) => !o)} title={t('nav.accountMenu')} style={{ cursor: 'pointer' }}>
        <div className="avatar">{initialOf(me.name)}</div>
        <div className="who">
          {me.name}
          <small>{t(accountRoleKey(me.role))} · {t('nav.accountMenu')}</small>
        </div>
      </div>
      {pwOpen && (
        <ChangePasswordModal
          onClose={() => setPwOpen(false)}
          onSaved={() => {
            setPwOpen(false);
            toast(t('settings.toast.passwordChanged'));
          }}
        />
      )}
    </div>
  );
}

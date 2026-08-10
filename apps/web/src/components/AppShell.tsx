'use client';

import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ConfirmProvider, ToastProvider, useConfirm, useToast } from './ui';
import { BrandLogo } from './BrandLogo';
import { accountRoleKey, initialOf } from '@/lib/labels';
import { HallContext } from '@/lib/hall';
import { ChurchContext, fetchModuleStates, useChurchProfile } from '@/lib/church';
import { I18nProvider, useT } from '@/lib/i18n';
import type { MessageKey } from '@/lib/i18n';
import { HallRow } from '@/lib/types';
import { AccountRole, Language, moduleForNavHref } from '@tog/shared';

type Me = {
  name: string;
  role: string;
  member: string | null;
  hall: string | null;
  /** Which group this session is scoped to — meaningful only for
   *  `group_leader` (migration 0026), the same shape `hall` already has for
   *  every hall-scoped role. Null for every other role. */
  group: string | null;
  language: Language;
};

/* -------------------------------------------------------------------------
 * Current-user context — pages read the session role to gate UI (rule G2).
 * ---------------------------------------------------------------------- */
const MeContext = createContext<Me | null>(null);

/** The logged-in account (name, role, member, hall, group). Only valid inside AppShell. */
export function useMe(): Me {
  return (
    useContext(MeContext) ??
    { name: '', role: '', member: null, hall: null, group: null, language: 'zh' }
  );
}

// Hall scope lives in lib/hall.tsx so useFetch can read it without importing
// the shell. Re-exported here since pages already import from AppShell.
export { useHallScope } from '@/lib/hall';

/* -------------------------------------------------------------------------
 * Page chrome context — a page sets the topbar title, nothing else. Its own
 * buttons go in its `PageBar`, next to its filters (see components/ui.tsx).
 * ---------------------------------------------------------------------- */
type Chrome = { title: string };
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
type NavItem = {
  href: string;
  label: MessageKey;
  icon: string;
  role?: AccountRole;
  /** Hidden from THIS role specifically, on top of (never instead of) the
   *  server's own path allowlist for it (`GROUP_LEADER_PREFIXES` in
   *  `api/[...path]/route.ts`) — see `visibleItems`' own comment. */
  hiddenFor?: AccountRole[];
};
const NAV: { section: MessageKey; items: NavItem[] }[] = [
  {
    section: 'nav.section.overview',
    items: [{ href: '/', label: 'nav.dashboard', icon: '◎' }],
  },
  {
    section: 'nav.section.care',
    items: [
      // A group_leader's own scope is one group, not the whole directory —
      // it reaches its own roster through /groups (narrowed to one row
      // server-side), never the full members list. 崇拜与祷告会 (services
      // roll call) is outside its allowlist entirely (`events` is not one
      // of `GROUP_LEADER_PREFIXES`), so the nav entry goes with it.
      { href: '/members', label: 'nav.members', icon: '👥', hiddenFor: [AccountRole.GroupLeader] },
      { href: '/groups', label: 'nav.groups', icon: '🔗' },
      { href: '/events', label: 'nav.events', icon: '📅', hiddenFor: [AccountRole.GroupLeader] },
    ],
  },
  {
    section: 'nav.section.growth',
    // None of these three is in the group_leader path allowlist either
    // (`trainings` / `discipleship` / `happiness`) — hidden here for the
    // same reason `/events` is, so a bookmark is the only way in, and that
    // lands on `RoleRestricted` (see each page's own guard).
    items: [
      { href: '/trainings', label: 'nav.trainings', icon: '📖', hiddenFor: [AccountRole.GroupLeader] },
      { href: '/happiness', label: 'nav.happiness', icon: '☺', hiddenFor: [AccountRole.GroupLeader] },
      { href: '/discipleship', label: 'nav.discipleship', icon: '✝', hiddenFor: [AccountRole.GroupLeader] },
    ],
  },
  {
    // User management and church settings are super_admin-only (matches the
    // API gate on /accounts and on every write to /church).
    section: 'nav.section.system',
    items: [
      { href: '/settings', label: 'nav.settings', icon: '⚙', role: AccountRole.SuperAdmin },
      { href: '/church', label: 'nav.church', icon: '⛪', role: AccountRole.SuperAdmin },
    ],
  },
];

/**
 * Which nav items this session may see. THREE independent gates, all of which
 * the server enforces too (rule G2):
 *  - the account's permission role (`item.role` — an allowlist: only that
 *    role sees it);
 *  - a role this item is explicitly hidden FROM (`item.hiddenFor` — a
 *    denylist, for a group_leader's narrower reach, which is everyone
 *    ELSE's normal reach minus a few pages rather than one role's own
 *    handful of pages);
 *  - whether the add-on module owning that href is switched on for this
 *    church. The mapping href → module comes from the shared registry, so a
 *    new optional module hides itself here without touching this file.
 */
function visibleItems(items: NavItem[], role: string, modules: Record<string, boolean>) {
  return items.filter((it) => {
    if (it.role && it.role !== role) return false;
    if (it.hiddenFor?.includes(role as AccountRole)) return false;
    const owner = moduleForNavHref(it.href);
    return !owner || modules[owner] !== false;
  });
}

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
  // The church's own record (name + logo) and which add-on modules it runs.
  // `modules` is null until it has resolved: the nav cannot be drawn before
  // then without flashing an entry this church may not have.
  const church = useChurchProfile();
  const [modules, setModules] = useState<Record<string, boolean> | null>(null);
  const reloadModules = useCallback(() => {
    void fetchModuleStates().then(setModules);
  }, []);

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
        // Independent of each other, so they go together rather than in
        // sequence (rule G6). The module states gate the nav, so the shell
        // waits for them below; the halls may arrive whenever.
        return Promise.all([
          fetch('/api/halls')
            .then((r) => (r.ok ? r.json() : []))
            .then((hs: HallRow[]) => {
              if (alive) setHalls(hs);
            })
            .catch(() => {}),
          fetchModuleStates().then((m) => {
            if (alive) setModules(m);
          }),
        ]);
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
        value={hallId}
        onChange={(e) => setHallId(e.target.value)}
        title={t('hall.switchTitle')}
      >
        <option value="">{t('hall.all')}</option>
        {halls.map((h) => (
          <option key={h.id} value={h.id}>{h.name}</option>
        ))}
      </select>
    ) : null;

  // The nav's shape depends on the module states as much as on the role, so
  // both have to be in hand before anything is drawn.
  if (!me || !modules) {
    return (
      <div className="loading" style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>
        {t('common.loading')}
      </div>
    );
  }

  return (
    <MeContext.Provider value={me}>
    <ChurchContext.Provider value={{ church, modules, reloadModules }}>
    <HallContext.Provider value={{ halls, hallId, setHallId, locked: !!me.hall }}>
    <ConfirmProvider>
    <ToastProvider>
      <ChromeContext.Provider value={setChrome}>
        <div className={`app-shell ${navOpen ? 'nav-open' : ''}`}>
          <aside className="sidebar">
            <div className="brand-head">
              <div className="brand-mark">
                <BrandLogo size={34} church={church} />
              </div>
              {/* The church's own name, from its record — not a translated
                  string: one church is called the same thing in every
                  interface language. `church.defaultName` only ever shows if
                  the record cannot be read at all. */}
              <div className="brand-name">{church?.short_name || church?.name || t('church.defaultName')}</div>
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
              const items = visibleItems(group.items, me.role, modules);
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
              {hallSwitcher && (
                <div className="flex items-center gap-10 topbar-actions">{hallSwitcher}</div>
              )}
            </div>

            <div className="content view-anim" key={pathname}>
              {children}
            </div>
          </div>
        </div>
      </ChromeContext.Provider>
    </ToastProvider>
    </ConfirmProvider>
    </HallContext.Provider>
    </ChurchContext.Provider>
    </MeContext.Provider>
  );
}

/**
 * The account block at the foot of the sidebar. It is a link straight to
 * 我的资料 (`/profile`) — the page every role, read-only included, uses to edit
 * its own details and password — with sign-out as a red item directly beneath
 * it. It used to be a toggle that popped a two-item menu over the nav, which
 * hid both destinations behind a tap and left the page it opened ambiguous.
 */
function NavUser({ me }: { me: Me }) {
  const t = useT();
  const confirm = useConfirm();
  const toast = useToast();

  const logout = async () => {
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
    <div className="nav-user-card">
      <Link href="/profile" className="nav-user" title={t('nav.myProfile')}>
        <div className="avatar">{initialOf(me.name)}</div>
        <div className="who">
          {me.name}
          <small>{t(accountRoleKey(me.role))} · {t('nav.myProfile')}</small>
        </div>
      </Link>
      {/* Inside the card and under the name, small and without an icon: the
          rows above are places in the app and carry icons to stay scannable,
          while this is the one thing you do to the account this card is
          showing. Giving it their weight made it compete with them. */}
      <button className="nav-signout" onClick={logout}>{t('nav.logout')}</button>
    </div>
  );
}

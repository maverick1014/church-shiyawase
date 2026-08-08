'use client';

import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { initialOf, roleDot, roleKey, roleTagStyle } from '@/lib/labels';
import { useHallScope } from '@/lib/hall';
import { useT } from '@/lib/i18n';

/* -------------------------------------------------------------------------
 * State helpers
 * ---------------------------------------------------------------------- */

/**
 * One centred line of text. Kept for the places where it is the right answer —
 * inside a modal, which is already a small bounded box. A page uses the
 * skeletons below instead: this line alone at the top of an empty page is
 * followed by the whole page snapping in underneath it.
 */
export function Loading() {
  const t = useT();
  return <div className="loading">{t('common.loading')}</div>;
}

/* -------------------------------------------------------------------------
 * Loading skeletons
 *
 * One composable set for every page (G4) — a page builds its loading state out
 * of these rather than hand-rolling its own. The rule of thumb: render the
 * page's real chrome (its `PageBar`, its `BackButton`, its section labels —
 * they all work with empty data) and skeletonise only the body that is
 * actually waiting on the fetch.
 *
 * Every block is decorative and `aria-hidden`; `SkeletonScreen` supplies the
 * one accessible status, so screen-reader users still hear `common.loading`.
 * ---------------------------------------------------------------------- */

/** Column widths for a skeleton table, cycled across the columns. Fixed pixels
 *  on purpose: a percentage inside an auto-layout `<td>` has no definite basis
 *  to resolve against and can collapse to nothing. */
const SKELETON_COL_W = [136, 92, 112, 76, 120, 96];

// Builds an index array — `Array.from({ length: n }, (_, i) => i)` at every
// skeleton call site read worse than naming it once.
const times = (n: number) => Array.from({ length: n }, (_, i) => i);

/**
 * A single shimmering block. Defaults to one full-width line of body text;
 * pass `width` / `height` / `radius` for anything else (an avatar is
 * `<Skeleton width={72} height={72} radius="50%" />`).
 */
export function Skeleton({
  width = '100%',
  height = 13,
  radius = 6,
  style,
}: {
  width?: number | string;
  height?: number | string;
  radius?: number | string;
  style?: React.CSSProperties;
}) {
  return <span className="sk" aria-hidden="true" style={{ width, height, borderRadius: radius, ...style }} />;
}

/**
 * `lines` stacked text lines. The last one is short — that asymmetry is what
 * makes a stack of bars read as a paragraph rather than as a table.
 */
export function SkeletonText({
  lines = 3,
  style,
}: {
  lines?: number;
  style?: React.CSSProperties;
}) {
  return (
    <div className="sk-lines" aria-hidden="true" style={style}>
      {times(lines).map((i) => (
        <Skeleton key={i} width={lines > 1 && i === lines - 1 ? '62%' : '100%'} />
      ))}
    </div>
  );
}

/** A `.card`-shaped placeholder: a heading line over `lines` body lines. */
export function SkeletonCard({
  title = true,
  lines = 3,
  style,
}: {
  title?: boolean;
  lines?: number;
  style?: React.CSSProperties;
}) {
  return (
    <div className="card" aria-hidden="true" style={style}>
      {title && <Skeleton width="42%" height={16} style={{ marginBottom: 16 }} />}
      <SkeletonText lines={lines} />
    </div>
  );
}

/** `count` cards in one of the shared grids — the shape the event and training
 *  catalogs land in, so the catalog doesn't reflow around them. */
export function SkeletonCards({
  count = 3,
  lines = 3,
  className = 'grid g3',
}: {
  count?: number;
  lines?: number;
  className?: string;
}) {
  return (
    <div className={className} aria-hidden="true">
      {times(count).map((i) => (
        <SkeletonCard key={i} lines={lines} />
      ))}
    </div>
  );
}

/**
 * The list-page workhorse: a header row over `rows` × `columns` body cells.
 *
 * It honours the same `.only-desktop` / `.only-mobile` split the real lists
 * use (G7), so a phone gets tile-shaped skeletons rather than a squashed
 * table. `bare` drops both the card chrome and the tile variant — for a table
 * that already lives inside a card and scrolls sideways on a phone too (the
 * weekly-attendance grid).
 */
export function SkeletonTable({
  rows = 6,
  columns = 5,
  bare,
}: {
  rows?: number;
  columns?: number;
  bare?: boolean;
}) {
  const cols = times(columns);
  const widthOf = (c: number) => SKELETON_COL_W[c % SKELETON_COL_W.length];
  const table = (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c}>
                <Skeleton width={Math.round(widthOf(c) * 0.62)} height={10} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {times(rows).map((r) => (
            <tr key={r}>
              {cols.map((c) => (
                <td key={c}>
                  <Skeleton width={widthOf(c)} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  if (bare) return <div aria-hidden="true">{table}</div>;

  return (
    <div aria-hidden="true">
      <div className="card only-desktop" style={{ padding: 6 }}>
        {table}
      </div>
      <div className="only-mobile">
        {times(rows).map((r) => (
          <div key={r} className="sk-tile">
            <div className="mtile-row1">
              <Skeleton width={148} height={15} />
              <Skeleton width={16} height={16} radius={8} />
            </div>
            <div className="mtile-line">
              <Skeleton width={196} height={11} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The shape of a detail page's opening card: the record's identity header over
 * its grid of fact tiles. Member detail and 我的资料 both render exactly that,
 * so their loading state is one component rather than two (G4). The tiles come
 * from `FactGrid` itself, so they can never drift from the real ones.
 */
export function SkeletonDetail({ facts = 8 }: { facts?: number }) {
  return (
    <div className="card" aria-hidden="true">
      <div className="entity-header">
        <div className="entity-header-id">
          <Skeleton width={72} height={72} radius="50%" />
          <div className="grow">
            <Skeleton width="46%" height={20} />
            <Skeleton width="62%" style={{ marginTop: 10 }} />
          </div>
        </div>
      </div>
      <FactGrid
        style={{ marginTop: 18 }}
        facts={times(facts).map(() => ({
          label: <Skeleton width="58%" height={10} />,
          value: <Skeleton width="76%" height={12} />,
        }))}
      />
    </div>
  );
}

/**
 * A page's loading state: the decorative shapes plus the one visually-hidden
 * live region that announces them. Every page goes through this rather than
 * repeating the aria wiring, and it reuses `common.loading` — the same string
 * the old `<Loading />` line showed — so nothing new had to be translated.
 */
export function SkeletonScreen({ children }: { children: ReactNode }) {
  const t = useT();
  return (
    <>
      <span className="sr-only" role="status" aria-live="polite">
        {t('common.loading')}
      </span>
      <div aria-hidden="true">{children}</div>
    </>
  );
}

export function ErrorBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return <div className="error-banner">⚠️ {message}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

/* -------------------------------------------------------------------------
 * Avatar, badges
 * ---------------------------------------------------------------------- */

export function Avatar({
  name,
  url,
  size = 'sm',
}: {
  name: string | null | undefined;
  url?: string | null;
  size?: 'sm' | 'md' | 'lg' | 'passport';
}) {
  const cls = `avatar ${size === 'sm' ? '' : size}`;
  if (url) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img className={cls} src={url} alt={name ?? ''} style={{ objectFit: 'cover' }} />;
  }
  return <div className={cls}>{initialOf(name)}</div>;
}

export function Badge({
  tone,
  dot,
  children,
}: {
  tone: string;
  dot?: string;
  children: ReactNode;
}) {
  return (
    <span className={`badge ${tone}`}>
      {dot && <i className="dot" style={{ background: dot }} />}
      {children}
    </span>
  );
}

/**
 * Derived-identity badge using the design's per-role tag palette + dot. Takes
 * the DisplayRole *code*, not a label, so the colour survives a language switch
 * and the wording comes from the dictionary.
 */
export function RoleBadge({ role }: { role: string }) {
  const t = useT();
  return (
    <span className="badge" style={roleTagStyle(role)}>
      <i className="dot" style={{ background: roleDot(role) }} />
      {t(roleKey(role))}
    </span>
  );
}

/* -------------------------------------------------------------------------
 * Card
 * ---------------------------------------------------------------------- */

export function Card({
  title,
  right,
  children,
  style,
}: {
  title?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div className="card" style={style}>
      {(title || right) && (
        <div className="card-head">
          {typeof title === 'string' ? <h3>{title}</h3> : title}
          {right}
        </div>
      )}
      {children}
    </div>
  );
}

/* -------------------------------------------------------------------------
 * Progress bar
 * ---------------------------------------------------------------------- */

export function ProgressBar({
  percent,
  label,
  thin,
}: {
  percent: number;
  label?: string;
  thin?: boolean;
}) {
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <div className="progress-row">
      <div className={`bar ${thin ? 'thin' : ''}`}>
        <span style={{ width: `${p}%` }} />
      </div>
      <span className="pct">{label ?? `${p}%`}</span>
    </div>
  );
}

/* -------------------------------------------------------------------------
 * Toggle switch
 * ---------------------------------------------------------------------- */

export function Switch({
  on,
  onToggle,
}: {
  on: boolean;
  onToggle?: () => void;
}) {
  return (
    <div className={`switch ${on ? 'on' : ''}`} onClick={onToggle} role="switch" aria-checked={on}>
      <div className="knob" />
    </div>
  );
}

/* -------------------------------------------------------------------------
 * Modal
 * ---------------------------------------------------------------------- */

export function Modal({
  title,
  onClose,
  children,
  size,
}: {
  title?: string;
  onClose: () => void;
  children: ReactNode;
  size?: 'wide' | 'narrow';
}) {
  const t = useT();
  return (
    // Clicking the backdrop is deliberately a no-op — an accidental click
    // outside the dialog must never discard an in-progress edit. Every modal
    // gets an explicit close affordance instead (the ✕ here, or the caller's
    // own header for modals that pass a custom title area via `children`).
    <div className="modal-backdrop">
      <div className={`modal ${size ?? ''}`}>
        {title && (
          <div className="flex-between" style={{ alignItems: 'flex-start', marginBottom: 16 }}>
            <h3 style={{ margin: 0 }}>{title}</h3>
            <button className="icon-btn" style={{ flexShrink: 0 }} onClick={onClose} title={t('common.close')}>✕</button>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label className="field-label">{label}</label>
      {children}
    </div>
  );
}

/* -------------------------------------------------------------------------
 * Icons — SVG rather than glyphs like › or ⬇, whose visual weight and vertical
 * centring drift between fonts and platforms. Stroke follows currentColor.
 * ---------------------------------------------------------------------- */

export function ChevronRightIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

export function ChevronLeftIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 6l-6 6 6 6" />
    </svg>
  );
}

export function RepeatIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17 2l4 4-4 4" />
      <path d="M3 11V9a4 4 0 0 1 4-4h14" />
      <path d="M7 22l-4-4 4-4" />
      <path d="M21 13v2a4 4 0 0 1-4 4H3" />
    </svg>
  );
}

export function LinkIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.5 1.5" />
      <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7L12 19" />
    </svg>
  );
}

export function DownloadIcon({ size = 17 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v12m0 0l-4.5-4.5M12 15l4.5-4.5M4 19h16" />
    </svg>
  );
}

export function InfoIcon({ size = 17 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 7.6v.2" />
    </svg>
  );
}

/**
 * The one "open this row" affordance — used by every list, in both the desktop
 * table and the mobile tile, so the control never differs between them.
 */
export function RowChevron({ title, onClick }: { title: string; onClick?: () => void }) {
  return (
    <button className="icon-btn" title={title} aria-label={title} onClick={onClick}>
      <ChevronRightIcon />
    </button>
  );
}

/**
 * The one export control. Icon-only (the label added nothing next to a column
 * of export-something buttons) and full control height, so it lines up with
 * the dropdowns it sits beside in a `PageBar`.
 */
export function ExportButton({
  onClick,
  disabled,
  title,
}: {
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  const t = useT();
  const label = title ?? t('common.export');
  return (
    <button className="btn ghost" onClick={onClick} disabled={disabled} title={label} aria-label={label}>
      <DownloadIcon />
    </button>
  );
}

/**
 * The one way back out of a detail page. Every page said something different
 * ("‹ Back to catalog", "‹ Back to accounts"…) at a non-standard height, in
 * the right corner. It is one control now: a chevron, the word "Back", the
 * shared `--control-h` like every other button, on the left where a back
 * affordance belongs.
 */
export function BackButton({ onClick }: { onClick: () => void }) {
  const t = useT();
  return (
    <button className="btn ghost back-btn" onClick={onClick}>
      <ChevronLeftIcon size={16} />
      {t('common.back')}
    </button>
  );
}

/**
 * A detail page's top row: back on the left, that record's page-level actions
 * in the right corner — the same left/right split as `PageBar`, so a detail
 * page and a list page read the same way. Use this instead of a bare
 * `BackButton` whenever the page has an action that belongs beside back
 * rather than inside the record's card.
 */
export function BackBar({ onBack, actions }: { onBack: () => void; actions?: ReactNode }) {
  return (
    <div className="back-bar">
      <BackButton onClick={onBack} />
      {actions && <div className="back-bar-actions">{actions}</div>}
    </div>
  );
}

/**
 * The one bar at the top of a list page: the page's filters on the left, its
 * own action buttons on the right — the same row on every page, at every
 * width. Page actions used to be handed to the shell via `usePageChrome`,
 * which rendered them in a separate stretch-to-fill row, so the top of each
 * list came out a different shape depending on how many buttons it had.
 *
 * Either half may be omitted; the actions stay in the right corner regardless.
 */
export function PageBar({ filters, actions }: { filters?: ReactNode; actions?: ReactNode }) {
  if (!filters && !actions) return null;
  return (
    <div className="page-bar">
      <div className="page-bar-filters">{filters}</div>
      {actions && <div className="page-bar-actions">{actions}</div>}
    </div>
  );
}

/**
 * The one header for a detail page: avatar + name + badges on the left, that
 * record's actions on the right. Member detail and account detail used to
 * build this shape by hand, differently — account detail let its identity
 * column shrink to nothing (`flex: 1; min-width: 0`), so at phone width the
 * name broke mid-word and the action button overlapped the badges instead of
 * wrapping under them. The identity column here keeps a real flex-basis, so
 * the actions drop to their own row when they no longer fit.
 */
export function EntityHeader({
  avatar,
  title,
  badges,
  sub,
  below,
  actions,
}: {
  avatar: ReactNode;
  title: ReactNode;
  badges?: ReactNode;
  sub?: ReactNode;
  below?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="entity-header">
      <div className="entity-header-id">
        {avatar}
        <div style={{ minWidth: 0 }}>
          <div className="flex items-center gap-10 flex-wrap">
            <h2 style={{ margin: 0, fontSize: 21 }} className="serif">{title}</h2>
            {badges}
          </div>
          {sub && <div className="muted" style={{ fontSize: 12.5, marginTop: 3 }}>{sub}</div>}
          {below}
        </div>
      </div>
      {actions && <div className="entity-header-actions">{actions}</div>}
    </div>
  );
}

/**
 * The read-only "facts" tiles under a detail page's header (email, phone,
 * congregation…). Member detail built this shape inline; the profile page needs
 * the same one, so it lives here once rather than being retyped per page
 * (rule G4). Values may be nodes, so a fact can carry a badge.
 */
export function FactGrid({
  facts,
  style,
}: {
  // The label is a node, not a string, so the loading skeleton can hand this
  // component placeholder bars and get the real tile back (rule G4) — which
  // also means the list is keyed by position rather than by its label text.
  facts: { label: ReactNode; value: ReactNode }[];
  style?: React.CSSProperties;
}) {
  return (
    <div className="grid g4" style={style}>
      {facts.map((f, i) => (
        <div
          key={i}
          style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 10, padding: '12px 14px' }}
        >
          <div className="muted" style={{ fontSize: 11.5 }}>{f.label}</div>
          <div style={{ fontSize: 14, fontWeight: 600, marginTop: 3 }}>{f.value}</div>
        </div>
      ))}
    </div>
  );
}

/**
 * Reference material that would otherwise push the real content down the page
 * (e.g. the permission matrix in 用户管理). Opens on hover and on click, so it
 * works on both a desktop pointer and a touch screen.
 */
export function InfoPopover({ label, children }: { label: string; children: ReactNode }) {
  // Hover and click are tracked separately on purpose. A single toggled flag
  // breaks on a pointer device: hovering opens it, and the click that follows
  // immediately closes it again. Clicking instead *pins* it open, so it
  // survives the pointer leaving — and it still works on touch, where there
  // is no hover at all.
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const open = pinned || hovered;
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!pinned) return;
    const onDocDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setPinned(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPinned(false);
    };
    document.addEventListener('mousedown', onDocDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [pinned]);

  return (
    <span
      ref={ref}
      className="info-pop"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        className="info-pop-trigger"
        aria-label={label}
        title={label}
        aria-expanded={open}
        onClick={() => setPinned((p) => !p)}
      >
        <InfoIcon />
      </button>
      {open && <span className="info-pop-body">{children}</span>}
    </span>
  );
}

/**
 * 堂会 picker, shared by every entity form so the options and the
 * 全堂开放 rule live in one place (rule G4).
 *
 * `allowAll` is for the nullable-hall entities (培训 / 聚会) where null means
 * 全堂开放. It is deliberately hidden from a hall-scoped account: those staff
 * may only create things inside their own hall, and the server enforces the
 * same (their /halls list contains just their hall).
 */
export function HallSelect({
  value,
  onChange,
  allowAll,
  allLabel,
}: {
  value: string | null;
  onChange: (hallId: string | null) => void;
  allowAll?: boolean;
  allLabel?: string;
}) {
  const { halls, locked } = useHallScope();
  const t = useT();
  return (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
      {allowAll && !locked && <option value="">{allLabel ?? t('hall.allOpen')}</option>}
      {!allowAll && !value && <option value="">{t('hall.choose')}</option>}
      {halls.map((h) => (
        <option key={h.id} value={h.id}>{h.name}</option>
      ))}
    </select>
  );
}

/**
 * Free-form tag entry: type a tag + Enter/comma to add it as a removable
 * chip. Reuses the existing `.chip` filter-chip look (no new CSS). Optional
 * `suggestions` (e.g. every tag already used elsewhere) power a native
 * `<datalist>` autocomplete so admins don't fragment spellings.
 */
let tagsInputId = 0;
export function TagsInput({
  value,
  onChange,
  suggestions,
  placeholder,
}: {
  value: string[];
  onChange: (tags: string[]) => void;
  suggestions?: string[];
  placeholder?: string;
}) {
  const tr = useT();
  const [draft, setDraft] = useState('');
  const [listId] = useState(() => `tags-suggest-${tagsInputId++}`);

  const commit = (raw: string) => {
    const t = raw.trim();
    if (t && !value.includes(t)) onChange([...value, t]);
    setDraft('');
  };

  return (
    <div>
      {value.length > 0 && (
        <div className="flex gap-6 flex-wrap" style={{ marginBottom: 8 }}>
          {value.map((t) => (
            <span key={t} className="chip on">
              {t}
              <button
                type="button"
                onClick={() => onChange(value.filter((x) => x !== t))}
                aria-label={tr('common.removeTag', { name: t })}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'inherit',
                  cursor: 'pointer',
                  padding: 0,
                  marginLeft: 2,
                  fontSize: 14,
                  lineHeight: 1,
                }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            commit(draft);
          }
        }}
        list={suggestions?.length ? listId : undefined}
        placeholder={placeholder ?? tr('common.tagsPlaceholder')}
      />
      {suggestions && suggestions.length > 0 && (
        <datalist id={listId}>
          {suggestions.filter((s) => !value.includes(s)).map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------
 * Sortable table header cell
 * ---------------------------------------------------------------------- */

export function SortTh({
  children,
  sortKey,
  activeKey,
  dir,
  onSort,
  align,
  className,
  style,
}: {
  children: ReactNode;
  sortKey: string;
  activeKey: string | null;
  dir: 'asc' | 'desc';
  onSort: (key: string) => void;
  align?: 'right' | 'center';
  /** Extra classes for the header cell. Widths are auto — don't set one. */
  className?: string;
  style?: React.CSSProperties;
}) {
  const active = activeKey === sortKey;
  return (
    <th
      className={`sortable ${className ?? ''}`}
      style={{ ...(align ? { textAlign: align } : undefined), ...style }}
      onClick={() => onSort(sortKey)}
      aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <span className="sort-label" style={align ? { justifyContent: align === 'center' ? 'center' : 'flex-end' } : undefined}>
        {children}
        <i className={`sort-caret ${active ? 'active' : ''} ${active && dir === 'desc' ? 'desc' : ''}`}>▲</i>
      </span>
    </th>
  );
}

/* -------------------------------------------------------------------------
 * Password input with a show/hide toggle
 * ---------------------------------------------------------------------- */

export function PasswordInput({
  value,
  onChange,
  placeholder,
  autoComplete,
  autoFocus,
  name,
  required,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoComplete?: string;
  autoFocus?: boolean;
  name?: string;
  required?: boolean;
}) {
  const t = useT();
  const [show, setShow] = useState(false);
  const toggleLabel = show ? t('common.hidePassword') : t('common.showPassword');
  return (
    <div className="pw-field">
      <input
        type={show ? 'text' : 'password'}
        value={value}
        name={name}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        required={required}
      />
      <button
        type="button"
        className="pw-toggle"
        onClick={() => setShow((s) => !s)}
        aria-label={toggleLabel}
        title={toggleLabel}
      >
        {show ? '🙈' : '👁'}
      </button>
    </div>
  );
}

/* -------------------------------------------------------------------------
 * Confirm dialog — a styled replacement for window.confirm()
 * ---------------------------------------------------------------------- */

type ConfirmOpts = {
  title?: string;
  message: ReactNode;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
};

const ConfirmContext = createContext<(o: ConfirmOpts) => Promise<boolean>>(() => Promise.resolve(false));

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const t = useT();
  const [state, setState] = useState<
    (ConfirmOpts & { resolve: (v: boolean) => void }) | null
  >(null);

  const confirm = useCallback((o: ConfirmOpts) => {
    return new Promise<boolean>((resolve) => setState({ ...o, resolve }));
  }, []);

  const close = (v: boolean) => {
    state?.resolve(v);
    setState(null);
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {state && (
        <div className="modal-backdrop">
          <div className="modal narrow" style={{ maxWidth: 400 }}>
            {state.title && <h3>{state.title}</h3>}
            <div style={{ fontSize: 13.5, color: 'var(--muted)', lineHeight: 1.7, margin: '2px 0 4px' }}>
              {state.message}
            </div>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => close(false)}>
                {state.cancelText ?? t('common.cancel')}
              </button>
              <button
                className="btn"
                style={
                  state.danger
                    ? { background: 'transparent', color: 'var(--crit)', border: '1px solid var(--crit-soft)' }
                    : undefined
                }
                onClick={() => close(true)}
                autoFocus
              >
                {state.confirmText ?? t('common.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  return useContext(ConfirmContext);
}

/* -------------------------------------------------------------------------
 * Toast
 * ---------------------------------------------------------------------- */

export type ToastVariant = 'success' | 'error';
type ToastItem = { id: number; message: string; variant: ToastVariant };

// The callback takes an optional variant so every call site can report both
// outcomes — `toast(t('group.toast.saved'))` (success, the default) or
// `toast(msg, 'error')`. Toasts stack top-right (top-centre on mobile) and
// auto-dismiss, so a burst of actions never clobbers itself.
const ToastContext = createContext<(message: string, variant?: ToastVariant) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(0);

  const show = useCallback((message: string, variant: ToastVariant = 'success') => {
    const id = nextId.current++;
    setToasts((list) => [...list, { id, message, variant }]);
    window.setTimeout(() => {
      setToasts((list) => list.filter((t) => t.id !== id));
    }, 2800);
  }, []);

  return (
    <ToastContext.Provider value={show}>
      {children}
      {toasts.length > 0 && (
        <div className="toast-stack">
          {toasts.map((t) => (
            <div key={t.id} className={`toast ${t.variant}`} role="status">
              <span className="toast-icon">{t.variant === 'error' ? '✕' : '✓'}</span>
              <span>{t.message}</span>
            </div>
          ))}
        </div>
      )}
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}

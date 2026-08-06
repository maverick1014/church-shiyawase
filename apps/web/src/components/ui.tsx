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

export function Loading() {
  const t = useT();
  return <div className="loading">{t('common.loading')}</div>;
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
 * of 导出-something buttons) and full control height, so it lines up with the
 * dropdowns it sits beside in a `.filter-bar`.
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

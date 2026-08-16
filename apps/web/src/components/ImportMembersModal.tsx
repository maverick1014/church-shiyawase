'use client';

import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { useHallScope } from '@/lib/hall';
import { exportRows } from '@/lib/export';
import { useT } from '@/lib/i18n';
import { importActionClass, importActionKey, importIssueKey } from '@/lib/labels';
import {
  IMPORT_COLUMNS,
  MAX_IMPORT_ROWS,
  excelSerialToDate,
  importFieldKey,
  matchImportColumn,
  planImport,
  type ImportField,
  type ImportPlan,
  type ImportRow,
} from '@/lib/members-import';
import type { GroupRow } from '@/lib/types';
import {
  ErrorBanner,
  MemberName,
  Modal,
  useConfirm,
  useFormGuard,
  useToast,
} from '@/components/ui';

/** One row of what the server did — its own plan, not the preview's. */
type ImportResult = {
  created: number;
  updated: number;
  skipped: Array<{ row: number; issue: string; field: string | null; detail: string | null; message: string }>;
  failures: Array<{ row: number; message: string }>;
  /**
   * A 小组长 login the server auto-provisioned while applying this import —
   * see `syncGroupLeaderAccount`. Shown ONCE, the same rule a single
   * promotion's own credential modal follows (rule G6): there is no second
   * place to find these passwords again. Optional so an older deployed build
   * (before this field existed) still renders — the results table below only
   * appears when the array is present and non-empty.
   */
  leader_accounts?: Array<{ row: number; email: string; password: string }>;
};

/**
 * A problem with the FILE, already phrased for the person holding it. Anything
 * else thrown while reading came out of SheetJS and says something about zip
 * headers, which is not a sentence anybody can act on.
 */
class FileProblem extends Error {}

/** The members the plan is matched against — every one, church-wide. */
type ImportMember = {
  id: string;
  full_name: string;
  english_name: string | null;
  hall_id: string;
  group_position: string | null;
  // So the PREVIEW refuses a BEST being put into a life group for the same
  // reason the server will (0032) — a preview that promises a row will apply
  // and then watches the server skip it is worse than no preview.
  church_role: string;
};

/**
 * 导入成员 — a spreadsheet of members, in two steps: see what it will do, then
 * do it.
 *
 * Nothing is written when a file is picked. The file is read in the browser,
 * `planImport` says what each row would do, and only a deliberate press sends
 * the rows to `POST /members/import`, which decides the same thing again
 * against the live database (rule G2: the preview is a courtesy).
 *
 * SheetJS is loaded on the first read, never at module level, exactly as
 * `lib/export.ts` loads it for the other direction (rule G6).
 */
export function ImportMembersModal({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const { halls, hallId, locked } = useHallScope();

  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [members, setMembers] = useState<ImportMember[]>([]);
  const [fileName, setFileName] = useState<string | null>(null);
  const [rows, setRows] = useState<ImportRow[] | null>(null);
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  // A parsed-but-not-yet-imported file is the unsaved work here: the church
  // picked a spreadsheet and reviewed the preview, and closing throws that
  // away. Once `result` exists the import has run, so closing is free again.
  const { close } = useFormGuard({ pending: rows !== null && !result }, onClose);

  /**
   * Deliberately NOT `useFetch`: that hook appends the congregation switcher's
   * `?hall_id=`, and a plan has to see EVERY member and EVERY life group. The
   * name pair is unique church-wide, so somebody filed in another congregation
   * is still the same person — a narrowed list would read them as new and the
   * server would then refuse the row nobody was warned about.
   */
  useEffect(() => {
    let alive = true;
    Promise.all([api.get<ImportMember[]>('/members'), api.get<GroupRow[]>('/groups')])
      .then(([m, g]) => {
        if (!alive) return;
        setMembers(m);
        setGroups(g);
      })
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, []);

  // Where a row that names no congregation lands: the one being viewed, or the
  // only one there is. The server re-decides this (a hall-scoped account is
  // pinned to its own hall regardless), so this is only what the preview shows.
  const defaultHallId = hallId || (halls.length === 1 ? halls[0].id : null);

  const plan: ImportPlan | null = useMemo(
    () =>
      rows
        ? planImport(rows, {
            halls,
            groups,
            existing: members,
            hallScope: locked ? (hallId || null) : null,
            defaultHallId,
          })
        : null,
    [rows, halls, groups, members, locked, hallId, defaultHallId],
  );

  /** The template, built from the same column list the importer reads. */
  const downloadTemplate = () => {
    const example: Record<string, string> = {};
    for (const column of IMPORT_COLUMNS) example[t(column.labelKey)] = '';
    // One filled-in row, so the shape of a date and of a congregation name is
    // on screen rather than described in a hint nobody reads.
    example[t(importFieldKey('full_name'))] = '陈约翰';
    example[t(importFieldKey('english_name'))] = 'John Tan';
    example[t(importFieldKey('phone'))] = '012-000 0000';
    example[t(importFieldKey('address'))] = '12, Jalan Merdeka, 43300 Seri Kembangan, Selangor';
    example[t(importFieldKey('date_of_birth'))] = '1990-05-04';
    example[t(importFieldKey('joined_at'))] = '2024-01-07';
    example[t(importFieldKey('hall'))] = halls[0]?.name ?? '';
    exportRows(t('import.templateFile'), t('import.title'), [example]);
  };

  const readFile = async (file: File) => {
    setError(null);
    setResult(null);
    setRows(null);
    setFileName(file.name);
    setReading(true);
    try {
      const XLSX = await import('xlsx');
      const wb = XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: 'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      if (!sheet) throw new FileProblem(t('import.err.empty'));
      // `blankrows: true` on purpose: a blank line in the middle of the file
      // must still occupy its position, or every row number after it would be
      // off by one and a refusal would point at the wrong line. The empty ones
      // are dropped below, after they have been counted.
      const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
        header: 1,
        raw: true,
        blankrows: true,
        defval: '',
      });
      if (matrix.length < 2) throw new FileProblem(t('import.err.empty'));

      // The header row names the columns in whichever of the three languages
      // the church works in; anything unrecognised is simply not imported.
      const header = (matrix[0] ?? []).map((cell) => matchImportColumn(String(cell ?? '')));
      if (!header.includes('full_name'))
        throw new FileProblem(t('import.err.missingColumn', { column: t(importFieldKey('full_name')) }));

      /**
       * One cell as text. A real Excel DATE cell is a NUMBER (days since
       * 1899-12-30), so a birthday column arrives as serials and reading it as
       * text would hand the church "32997". `excelSerialToDate` turns it into
       * `YYYY-MM-DD` with no `Date` and no timezone involved (rule G6a); a
       * number that is not a date at all falls through as itself, so the plan
       * reports it as a bad date naming the value rather than inventing one.
       */
      const cellText = (value: unknown, field: ImportField): string => {
        if (value === null || value === undefined) return '';
        if (typeof value === 'number' && (field === 'date_of_birth' || field === 'joined_at'))
          return excelSerialToDate(value) ?? String(value);
        return String(value);
      };

      const parsed: ImportRow[] = [];
      for (let i = 1; i < matrix.length; i++) {
        const cells = matrix[i] ?? [];
        // The spreadsheet's OWN row number — this is a file somebody will open
        // and fix, so a refusal has to point at the row they can see.
        const row: ImportRow = { row: i + 1 };
        let anything = false;
        header.forEach((field, column) => {
          if (!field) return;
          const text = cellText(cells[column], field);
          if (text.trim() === '') return;
          row[field] = text;
          anything = true;
        });
        if (anything) parsed.push(row);
      }
      if (parsed.length === 0) throw new FileProblem(t('import.err.empty'));
      if (parsed.length > MAX_IMPORT_ROWS)
        throw new FileProblem(t('import.err.tooManyRows', { max: MAX_IMPORT_ROWS, n: parsed.length }));
      setRows(parsed);
    } catch (e) {
      setError(e instanceof FileProblem ? e.message : t('import.err.read'));
      setFileName(null);
    } finally {
      setReading(false);
    }
  };

  const apply = async () => {
    if (!plan || !rows) return;
    // Overwriting members the church already has is irreversible, so it is
    // named and asked about first (rule G3). Adding new people is not.
    if (plan.updated > 0) {
      const ok = await confirm({
        title: t('import.confirm.title'),
        message: t('import.confirm.message', { updated: plan.updated, created: plan.created }),
        confirmText: t('import.confirm.ok'),
        danger: true,
      });
      if (!ok) return;
    }
    setSaving(true);
    setError(null);
    try {
      // Every row goes, including the ones this preview would skip: the server
      // plans them again and reports its own verdict, so a disagreement shows
      // up in the result rather than being hidden by the client.
      const r = await api.post<ImportResult>('/members/import', { rows, hall_id: defaultHallId });
      setResult(r);
      toast(t('import.done.summary', { created: r.created, updated: r.updated, skipped: r.skipped.length }));
      onDone();
    } catch (e) {
      setError((e as Error).message);
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const reset = () => {
    setRows(null);
    setResult(null);
    setFileName(null);
    setError(null);
  };

  return (
    <Modal title={t('import.title')} onClose={close} size="wide">
      <ErrorBanner message={error} />

      {result ? (
        <>
          <div className="section-label" style={{ marginBottom: 10 }}>{t('import.done')}</div>
          <p style={{ fontSize: 14, margin: '0 0 12px' }}>
            {t('import.done.summary', {
              created: result.created,
              updated: result.updated,
              skipped: result.skipped.length,
            })}
          </p>
          {(result.failures.length > 0 || result.skipped.length > 0) && (
            <>
              <div className="faint" style={{ fontSize: 12, marginBottom: 6 }}>{t('import.done.failures')}</div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.9 }}>
                {result.failures.map((f) => (
                  <li key={`f${f.row}`}>{t('import.col.row')} {f.row} — {f.message}</li>
                ))}
                {result.skipped.map((s) => (
                  <li key={`s${s.row}`}>{t('import.col.row')} {s.row} — {s.message}</li>
                ))}
              </ul>
            </>
          )}
          {/* A generated 小组长 login per row, shown ONCE — see the type's own
              comment (rule G6). An import can create several in one run, so
              this is a small results TABLE rather than a modal per row (the
              single-promotion flow's own shape, `LeaderAccountEvent.tsx`). */}
          {result.leader_accounts && result.leader_accounts.length > 0 && (
            <>
              <div className="section-label" style={{ marginTop: 14, marginBottom: 4 }}>
                {t('import.leaderAccounts.title')}
              </div>
              <div className="hint" style={{ marginBottom: 8 }}>{t('import.leaderAccounts.hint')}</div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>{t('import.leaderAccounts.col.row')}</th>
                      <th>{t('import.leaderAccounts.col.email')}</th>
                      <th>{t('import.leaderAccounts.col.password')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.leader_accounts.map((a) => (
                      <tr key={a.row}>
                        <td className="muted tnum">{a.row}</td>
                        <td>{a.email}</td>
                        <td style={{ fontFamily: 'monospace' }}>{a.password}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          <div className="modal-actions">
            <button className="btn ghost" onClick={reset}>{t('import.another')}</button>
            <button className="btn" onClick={close}>{t('common.close')}</button>
          </div>
        </>
      ) : !plan ? (
        <>
          <p className="muted" style={{ fontSize: 13, lineHeight: 1.8, marginTop: 0 }}>{t('import.intro')}</p>
          <div className="flex items-center gap-10 flex-wrap" style={{ margin: '14px 0' }}>
            <input
              type="file"
              accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
              aria-label={t('import.pick')}
              disabled={reading}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void readFile(file);
              }}
            />
            <button className="btn ghost" onClick={downloadTemplate}>{t('import.template')}</button>
          </div>
          {reading && <div className="loading">{t('import.reading')}</div>}
          <div className="hint">{t('import.hint')}</div>
          <div className="modal-actions">
            <button className="btn ghost" onClick={close}>{t('common.cancel')}</button>
          </div>
        </>
      ) : (
        <>
          <div className="flex-between flex-wrap" style={{ gap: 8, marginBottom: 10 }}>
            <div className="section-label">{t('import.preview')}</div>
            <div className="muted" style={{ fontSize: 12.5 }}>
              {fileName && `${t('import.picked', { name: fileName })} · `}
              {t('import.summary', { created: plan.created, updated: plan.updated, skipped: plan.skipped })}
            </div>
          </div>
          <div className="table-wrap" style={{ maxHeight: '46vh', overflowY: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>{t('import.col.row')}</th>
                  <th>{t('import.col.member')}</th>
                  <th>{t('import.col.action')}</th>
                  <th>{t('import.col.detail')}</th>
                </tr>
              </thead>
              <tbody>
                {plan.rows.map((row) => (
                  <tr key={row.row}>
                    <td className="muted tnum">{row.row}</td>
                    <td>
                      <MemberName member={row.full_name ? row : null} fallback="—" />
                    </td>
                    <td>
                      <span className={`badge ${importActionClass(row.action)}`}>
                        {t(importActionKey(row.action))}
                      </span>
                    </td>
                    <td className="muted" style={{ whiteSpace: 'normal' }}>
                      {row.issue
                        ? t(importIssueKey(row.issue), {
                            value: row.detail ?? '',
                            field: row.field ? t(importFieldKey(row.field)) : '',
                          })
                        : row.action === 'update'
                          ? t('import.updating', {
                              fields: row.fields.map((f) => t(importFieldKey(f))).join('、'),
                            })
                          : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {plan.created + plan.updated === 0 && <div className="hint mt-14">{t('import.nothing')}</div>}
          <div className="modal-actions">
            <button className="btn ghost" onClick={reset} disabled={saving}>{t('import.another')}</button>
            <button
              className="btn"
              onClick={apply}
              disabled={saving || plan.created + plan.updated === 0}
            >
              {saving ? t('import.applying') : t('import.apply', { n: plan.created + plan.updated })}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

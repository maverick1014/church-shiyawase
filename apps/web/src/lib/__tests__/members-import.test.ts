import { describe, expect, it } from 'vitest';
import {
  IMPORT_COLUMNS,
  excelSerialToDate,
  matchImportColumn,
  pairKey,
  parseImportDate,
  planImport,
  tidy,
  type ImportContext,
} from '../members-import';
import { en } from '../i18n/en';
import { ms } from '../i18n/ms';
import { zh } from '../i18n/zh';

/*
 * The importer's rules, and the one property the whole thing rests on: a member
 * is the PAIR of names, compared exactly the way `members_name_pair_key`
 * compares it (migration 0018). Everything else here is about a spreadsheet a
 * person will fix and upload again — a rejected row has to name the row and the
 * value, and a bad cell must never take the rest of the file with it.
 */

const HALL_CN = { id: 'hall-cn', name: '中文堂' };
const HALL_EN = { id: 'hall-en', name: '英文堂' };

const ctx = (over: Partial<ImportContext> = {}): ImportContext => ({
  halls: [HALL_CN, HALL_EN],
  groups: [{ id: 'g1', name: '晨曦小组', hall_id: HALL_CN.id }],
  existing: [],
  hallScope: null,
  defaultHallId: HALL_CN.id,
  ...over,
});

const member = (over: Partial<ImportContext['existing'][number]> = {}) => ({
  id: 'm1',
  full_name: '陈约翰',
  english_name: 'John Tan',
  hall_id: HALL_CN.id,
  group_position: null,
  ...over,
});

describe('tidy / pairKey', () => {
  it('folds the whitespace Postgres btrim cannot see', () => {
    // A full-width space and a non-breaking space are not ASCII spaces, so a
    // name carrying either would sit in the table with invisible padding and
    // the unique index would let a second copy in.
    expect(tidy('　陈  约翰 ')).toBe('陈 约翰');
    expect(tidy('Ｊｏｈｎ')).toBe('John');
  });

  it('is the same key for the same person typed two ways', () => {
    expect(pairKey(' 陈约翰 ', 'john tan')).toBe(pairKey('陈约翰', 'John Tan'));
  });

  it('treats “no English name” as a value, not as unknown', () => {
    expect(pairKey('张伟', null)).toBe(pairKey('张伟', '  '));
    expect(pairKey('张伟', null)).not.toBe(pairKey('张伟', 'David'));
  });
});

describe('matchImportColumn', () => {
  it('reads a header in any of the three interface languages', () => {
    expect(matchImportColumn('Chinese name')).toBe('full_name');
    expect(matchImportColumn('中文名')).toBe('full_name');
    expect(matchImportColumn('Nama Cina')).toBe('full_name');
  });

  it('ignores case, spacing and decoration around a header', () => {
    expect(matchImportColumn('  ENGLISH  NAME * ')).toBe('english_name');
    expect(matchImportColumn('电话')).toBe('phone');
  });

  it('answers null for a column this app does not import', () => {
    expect(matchImportColumn('奉献总额')).toBeNull();
    expect(matchImportColumn('')).toBeNull();
  });

  it('accepts every dictionary’s own label for every column', () => {
    // The template writes the header from the dictionary and this module reads
    // it back. Renaming a label in one place and not the other would break a
    // round trip nobody would notice until a church uploaded its own template.
    for (const dict of [en, zh, ms]) {
      for (const column of IMPORT_COLUMNS) {
        expect(matchImportColumn(dict[column.labelKey])).toBe(column.field);
      }
    }
  });
});

describe('parseImportDate', () => {
  it('takes year-first dates and normalises them', () => {
    expect(parseImportDate('1990-05-04')).toBe('1990-05-04');
    expect(parseImportDate('1990/5/4')).toBe('1990-05-04');
    expect(parseImportDate('19900504')).toBe('1990-05-04');
  });

  it('refuses a date nobody can read the same way twice', () => {
    // 03/04/2026 is two different days depending on who is reading it.
    expect(parseImportDate('03/04/2026')).toBeNull();
    expect(parseImportDate('4 May 1990')).toBeNull();
  });

  it('refuses a day that does not exist', () => {
    expect(parseImportDate('2026-02-30')).toBeNull();
    expect(parseImportDate('2026-13-01')).toBeNull();
    expect(parseImportDate('2024-02-29')).toBe('2024-02-29'); // leap year
    expect(parseImportDate('2026-02-29')).toBeNull();
  });
});

describe('excelSerialToDate', () => {
  it('turns the number a date cell really is into a date', () => {
    // 32997 is what Excel (and SheetJS) store for the 4th of May 1990 — the
    // serials below were read back out of a real .xlsx written by SheetJS.
    expect(excelSerialToDate(32997)).toBe('1990-05-04');
    expect(excelSerialToDate(45298)).toBe('2024-01-07');
    expect(excelSerialToDate(25569)).toBe('1970-01-01');
    expect(excelSerialToDate(45298.75)).toBe('2024-01-07'); // a date with a time on it
  });

  it('refuses the serials that are not dates', () => {
    // 60 is Excel's 29th of February 1900, a day that never existed — and
    // anything under it is a small number that landed in a date column.
    expect(excelSerialToDate(60)).toBeNull();
    expect(excelSerialToDate(1)).toBeNull();
    expect(excelSerialToDate(-4)).toBeNull();
    expect(excelSerialToDate(Number.NaN)).toBeNull();
  });
});

describe('planImport', () => {
  it('adds somebody nobody has', () => {
    const plan = planImport([{ row: 2, full_name: '陈约翰', english_name: 'John Tan' }], ctx());
    expect(plan.created).toBe(1);
    expect(plan.rows[0]).toMatchObject({ action: 'create', row: 2 });
    expect(plan.rows[0].values).toMatchObject({
      full_name: '陈约翰',
      english_name: 'John Tan',
      hall_id: HALL_CN.id,
    });
  });

  it('updates the person already filed under that pair, however it was typed', () => {
    const plan = planImport(
      [{ row: 2, full_name: ' 陈约翰', english_name: 'JOHN TAN', phone: '012-345 6789' }],
      ctx({ existing: [member()] }),
    );
    expect(plan.updated).toBe(1);
    expect(plan.rows[0]).toMatchObject({ action: 'update', member_id: 'm1' });
    expect(plan.rows[0].values.phone).toBe('012-345 6789');
  });

  it('never blanks a column the file left empty', () => {
    // The whole point of a sparse re-import: a file carrying only names and
    // birthdays must not wipe the phone numbers the church already had.
    const plan = planImport(
      [{ row: 2, full_name: '陈约翰', english_name: 'John Tan', phone: '', email: '   ' }],
      ctx({ existing: [member()] }),
    );
    expect(plan.rows[0].values).not.toHaveProperty('phone');
    expect(plan.rows[0].values).not.toHaveProperty('email');
  });

  it('tells the same Chinese name with different English names apart', () => {
    const plan = planImport(
      [
        { row: 2, full_name: '张伟', english_name: 'David' },
        { row: 3, full_name: '张伟', english_name: 'Daniel' },
      ],
      ctx(),
    );
    expect(plan.created).toBe(2);
    expect(plan.skipped).toBe(0);
  });

  it('refuses the same pair twice in one file, naming the row it repeats', () => {
    const plan = planImport(
      [
        { row: 2, full_name: '张伟' },
        { row: 7, full_name: ' 张伟 ' },
      ],
      ctx(),
    );
    expect(plan.created).toBe(1);
    expect(plan.rows[1]).toMatchObject({ action: 'skip', issue: 'duplicate_in_file', detail: '2' });
  });

  it('refuses a row with no Chinese name', () => {
    const plan = planImport([{ row: 2, english_name: 'John Tan', phone: '012-3456789' }], ctx());
    expect(plan.rows[0]).toMatchObject({ action: 'skip', issue: 'name_missing' });
  });

  it('says which value it choked on, and lets the rest of the file through', () => {
    const plan = planImport(
      [
        { row: 2, full_name: '甲', date_of_birth: '4 May 1990' },
        { row: 3, full_name: '乙', email: 'not-an-email' },
        { row: 4, full_name: '丙', phone: 'call the office' },
        { row: 5, full_name: '丁', gender: 'yes' },
        { row: 6, full_name: '戊', church_role: 'archbishop' },
        { row: 7, full_name: '己', status: 'maybe' },
        { row: 8, full_name: '庚', hall: '德文堂' },
        { row: 9, full_name: '辛', group: '黄昏小组' },
        { row: 10, full_name: '壬' },
      ],
      ctx(),
    );
    expect(plan.rows.map((r) => r.issue)).toEqual([
      'bad_date',
      'bad_email',
      'bad_phone',
      'unknown_gender',
      'unknown_role',
      'unknown_status',
      'unknown_hall',
      'unknown_group',
      undefined,
    ]);
    expect(plan.rows[0].detail).toBe('4 May 1990');
    expect(plan.created).toBe(1);
  });

  it('reads an enum in any of the three languages', () => {
    const plan = planImport(
      [
        { row: 2, full_name: '甲', gender: '女', church_role: 'Deacon', status: 'Berhenti hadir' },
      ],
      ctx(),
    );
    expect(plan.rows[0].values).toMatchObject({
      gender: 'female',
      church_role: 'deacon',
      status: 'inactive',
    });
  });

  it('starts a member joining a group as a new member, and never demotes one', () => {
    const plan = planImport(
      [
        { row: 2, full_name: '甲', group: '晨曦小组' },
        { row: 3, full_name: '陈约翰', english_name: 'John Tan', group: '晨曦小组' },
      ],
      ctx({ existing: [member({ group_position: 'leader' })] }),
    );
    expect(plan.rows[0].values).toMatchObject({ group_id: 'g1', group_position: 'new_member' });
    expect(plan.rows[1].values).not.toHaveProperty('group_position');
  });

  it('refuses a life group from another congregation', () => {
    const plan = planImport([{ row: 2, full_name: '甲', hall: '英文堂', group: '晨曦小组' }], ctx());
    expect(plan.rows[0]).toMatchObject({ action: 'skip', issue: 'group_other_hall' });
  });

  it('needs a congregation when the church has more than one and none is named', () => {
    const plan = planImport([{ row: 2, full_name: '甲' }], ctx({ defaultHallId: null }));
    expect(plan.rows[0]).toMatchObject({ action: 'skip', issue: 'no_hall' });
  });

  it('keeps a hall-scoped account inside its own congregation', () => {
    const scoped = ctx({
      hallScope: HALL_CN.id,
      defaultHallId: HALL_CN.id,
      existing: [member({ hall_id: HALL_EN.id })],
    });
    const plan = planImport(
      [
        { row: 2, full_name: '甲', hall: '英文堂' }, // creating elsewhere
        { row: 3, full_name: '陈约翰', english_name: 'John Tan' }, // somebody else's member
        { row: 4, full_name: '乙' },
      ],
      scoped,
    );
    expect(plan.rows.map((r) => r.issue)).toEqual(['other_hall', 'other_hall', undefined]);
  });

  it('refuses a cell holding a paragraph rather than a name', () => {
    const plan = planImport([{ row: 2, full_name: '甲'.repeat(200) }], ctx());
    expect(plan.rows[0]).toMatchObject({ action: 'skip', issue: 'too_long', field: 'full_name' });
  });
});

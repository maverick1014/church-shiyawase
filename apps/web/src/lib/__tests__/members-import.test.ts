import { describe, expect, it } from 'vitest';
import {
  IMPORT_COLUMNS,
  excelSerialToDate,
  matchImportColumn,
  pairKey,
  parseImportDate,
  parseList,
  planImport,
  referrerKeys,
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
    expect(matchImportColumn('洗礼日期')).toBeNull();
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

  it('reads a cell of 服侍岗位 however the church punctuated it', () => {
    const plan = planImport([{ row: 2, full_name: '甲', serving_roles: '敬拜、音响 ; 招待/投影' }], ctx());
    expect(plan.rows[0].values.serving_roles).toEqual(['敬拜', '音响', '招待', '投影']);
    expect(plan.rows[0].fields).toContain('serving_roles');
  });

  it('never blanks the ministries a file said nothing about', () => {
    // The same rule every other column obeys: a blank cell is "nothing to say",
    // so a re-import of names and phones cannot un-serve the whole church.
    const plan = planImport(
      [{ row: 2, full_name: '陈约翰', english_name: 'John Tan', serving_roles: ' 、 ; ' }],
      ctx({ existing: [member()] }),
    );
    expect(plan.rows[0].values).not.toHaveProperty('serving_roles');
  });
});

/*
 * 地址 and 推荐人 (migration 0021). The address is one more free-text column;
 * the referrer is the interesting one — a spreadsheet holds NAMES, so it has to
 * be resolved back to a member the way the pair index compares one, and a name
 * that answers to nobody or to two people is refused rather than guessed at.
 */
describe('planImport · address & 推荐人', () => {
  const DAVID = member({ id: 'm-david', full_name: '张伟', english_name: 'David' });
  const DANIEL = member({ id: 'm-daniel', full_name: '张伟', english_name: 'Daniel' });
  const ALONE = member({ id: 'm-alone', full_name: '李明', english_name: null });

  it('takes an address as the free text it is', () => {
    const plan = planImport(
      [{ row: 2, full_name: '甲', address: ' 12, Jalan Merdeka,　43300 Seri Kembangan ' }],
      ctx(),
    );
    expect(plan.rows[0].values.address).toBe('12, Jalan Merdeka, 43300 Seri Kembangan');
    expect(plan.rows[0].fields).toContain('address');
  });

  it('leaves an address the file said nothing about alone', () => {
    const plan = planImport(
      [{ row: 2, full_name: '陈约翰', english_name: 'John Tan', address: '  ' }],
      ctx({ existing: [member()] }),
    );
    expect(plan.rows[0].values).not.toHaveProperty('address');
  });

  it('resolves a referrer named by their Chinese name alone', () => {
    const plan = planImport([{ row: 2, full_name: '甲', referred_by: ' 李明 ' }], ctx({ existing: [ALONE] }));
    expect(plan.rows[0].values.referred_by).toBe('m-alone');
    expect(plan.rows[0].fields).toContain('referred_by');
  });

  it('resolves a referrer named by the pair, however it was cased', () => {
    const plan = planImport(
      [{ row: 2, full_name: '甲', referred_by: '张伟 DAVID' }],
      ctx({ existing: [DAVID, DANIEL] }),
    );
    expect(plan.rows[0].values.referred_by).toBe('m-david');
  });

  it('reads a bare Chinese name as the person who has no English name', () => {
    // The same cell in the 中文名 column would match that person and not the
    // other, because "no English name" is a value of its own (0018) — so the
    // referral column has to read it the same way rather than calling it
    // ambiguous and refusing a row a church wrote correctly.
    const WEI = member({ id: 'm-wei', full_name: '张伟', english_name: null });
    const plan = planImport(
      [{ row: 2, full_name: '甲', referred_by: '张伟' }],
      ctx({ existing: [WEI, DAVID] }),
    );
    expect(plan.rows[0].values.referred_by).toBe('m-wei');
  });

  it('refuses a referrer nobody on the roll answers to', () => {
    const plan = planImport([{ row: 2, full_name: '甲', referred_by: '王五' }], ctx({ existing: [ALONE] }));
    expect(plan.rows[0]).toMatchObject({
      action: 'skip',
      issue: 'unknown_referrer',
      field: 'referred_by',
      detail: '王五',
    });
  });

  it('refuses a referrer two people answer to rather than picking one', () => {
    const plan = planImport(
      [{ row: 2, full_name: '甲', referred_by: '张伟' }],
      ctx({ existing: [DAVID, DANIEL] }),
    );
    expect(plan.rows[0]).toMatchObject({
      action: 'skip',
      issue: 'ambiguous_referrer',
      field: 'referred_by',
      detail: '张伟',
    });
  });

  it('refuses somebody as their own referrer, which the database refuses too', () => {
    const plan = planImport(
      [{ row: 2, full_name: '李明', referred_by: '李明' }],
      ctx({ existing: [ALONE] }),
    );
    expect(plan.rows[0]).toMatchObject({ action: 'skip', issue: 'self_referrer', detail: '李明' });
  });

  it('lets the rows around a bad referrer through', () => {
    const plan = planImport(
      [
        { row: 2, full_name: '甲', referred_by: '查无此人' },
        { row: 3, full_name: '乙', referred_by: '李明' },
      ],
      ctx({ existing: [ALONE] }),
    );
    expect(plan.rows.map((r) => r.issue)).toEqual(['unknown_referrer', undefined]);
    expect(plan.created).toBe(1);
  });
});

describe('referrerKeys', () => {
  it('offers the Chinese name alone, and the pair when there is an English one', () => {
    expect(referrerKeys('陈约翰', 'John Tan')).toEqual(['陈约翰', '陈约翰 john tan']);
    expect(referrerKeys('李明', null)).toEqual(['李明']);
  });

  it('folds a name the way pairKey folds one', () => {
    expect(referrerKeys(' 陈约翰 ', ' JOHN  TAN ')).toEqual(['陈约翰', '陈约翰 john tan']);
  });
});

describe('parseList', () => {
  it('trims each ministry and drops the empties a trailing separator leaves', () => {
    expect(parseList(' 敬拜 , 司琴,, ')).toEqual(['敬拜', '司琴']);
    expect(parseList('')).toEqual([]);
  });

  it('keeps one ministry once, however many times the cell names it', () => {
    expect(parseList('敬拜、敬拜')).toEqual(['敬拜']);
  });

  it('reads every separator a Chinese or an English keyboard produces', () => {
    // The same list the shared TagsInput ends a chip on, so a ministry typed
    // into the form and one written into a cell are split the same way.
    expect(parseList('敬拜，音响')).toEqual(['敬拜', '音响']);
    expect(parseList('敬拜；音响／招待')).toEqual(['敬拜', '音响', '招待']);
  });
});

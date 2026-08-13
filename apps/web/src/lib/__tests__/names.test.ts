import { describe, expect, it } from 'vitest';
import { HallNameDisplay } from '@tog/shared';
import { hallNameDisplay, memberAltName, memberDisplayName } from '../names';

const zhHall = { id: 'h-zh', name_display: HallNameDisplay.Chinese };
const enHall = { id: 'h-en', name_display: HallNameDisplay.English };
/** A congregation on a database that has not had 0028 applied yet. */
const oldHall = { id: 'h-old' };
const halls = [zhHall, enHall, oldHall];

const both = { full_name: '张伟', english_name: 'David' };
const zhOnly = { full_name: '张伟', english_name: null };
const enOnly = { full_name: '', english_name: 'David' };

describe('memberDisplayName', () => {
  it('shows the Chinese name in a Chinese congregation', () => {
    expect(memberDisplayName(both, HallNameDisplay.Chinese)).toBe('张伟');
  });

  it('shows the English name in an English congregation', () => {
    expect(memberDisplayName(both, HallNameDisplay.English)).toBe('David');
  });

  it('shows whichever name exists, whatever the congregation prefers', () => {
    // The ordinary case: plenty of people have no English name, and an English
    // congregation still has to draw SOMETHING for them.
    expect(memberDisplayName(zhOnly, HallNameDisplay.English)).toBe('张伟');
    expect(memberDisplayName(enOnly, HallNameDisplay.Chinese)).toBe('David');
  });

  it('falls back to the Chinese name when the congregation is unknown', () => {
    // A public page with no session, a payload with no hall, a database still
    // waiting on 0028 — all three land here.
    expect(memberDisplayName(both, undefined)).toBe('张伟');
    expect(memberDisplayName(both, null)).toBe('张伟');
  });

  it('ignores whitespace-only names rather than drawing a blank', () => {
    expect(memberDisplayName({ full_name: '张伟', english_name: '   ' })).toBe('张伟');
    expect(memberDisplayName({ full_name: '  ', english_name: 'David' })).toBe('David');
  });

  it('answers empty for nobody', () => {
    expect(memberDisplayName(null)).toBe('');
    expect(memberDisplayName(undefined)).toBe('');
  });
});

describe('memberAltName', () => {
  it('is the name NOT shown, so a search can still match it', () => {
    expect(memberAltName(both, HallNameDisplay.Chinese)).toBe('David');
    expect(memberAltName(both, HallNameDisplay.English)).toBe('张伟');
  });

  it('is null when the person has only one name', () => {
    expect(memberAltName(zhOnly, HallNameDisplay.Chinese)).toBeNull();
    expect(memberAltName(zhOnly, HallNameDisplay.English)).toBeNull();
    expect(memberAltName(null)).toBeNull();
  });
});

describe('hallNameDisplay', () => {
  it('reads the congregation the member belongs to', () => {
    expect(hallNameDisplay(halls, 'h-en')).toBe(HallNameDisplay.English);
    expect(hallNameDisplay(halls, 'h-zh')).toBe(HallNameDisplay.Chinese);
  });

  it('treats a hall that has not been told as Chinese', () => {
    // 0028 not applied: the column is simply absent from the payload, which
    // must read as "nobody has said", not as an error.
    expect(hallNameDisplay(halls, 'h-old')).toBe(HallNameDisplay.Chinese);
  });

  it('treats a missing or unknown hall as Chinese rather than throwing', () => {
    expect(hallNameDisplay(halls, null)).toBe(HallNameDisplay.Chinese);
    expect(hallNameDisplay(halls, 'gone')).toBe(HallNameDisplay.Chinese);
    expect(hallNameDisplay(null, 'h-en')).toBe(HallNameDisplay.Chinese);
    expect(hallNameDisplay([], 'h-en')).toBe(HallNameDisplay.Chinese);
  });
});

import { describe, it, expect } from 'vitest';
import {
  displayRole,
  canPromoteToLeadership,
  ChurchRole,
  DisplayRole,
  GroupPosition,
} from '@tog/shared';

describe('displayRole', () => {
  it('returns the pastor code for a pastor', () => {
    expect(displayRole({ church_role: ChurchRole.Pastor, group_position: null })).toBe(
      DisplayRole.Pastor,
    );
  });

  it('returns the deacon code for a deacon', () => {
    expect(displayRole({ church_role: ChurchRole.Deacon, group_position: null })).toBe(
      DisplayRole.Deacon,
    );
  });

  it('returns the co-worker code for a co-worker', () => {
    expect(displayRole({ church_role: ChurchRole.CoWorker, group_position: null })).toBe(
      DisplayRole.CoWorker,
    );
  });

  it('falls back to the group position for a plain member', () => {
    expect(
      displayRole({ church_role: ChurchRole.Member, group_position: GroupPosition.Leader }),
    ).toBe(DisplayRole.Leader);
  });

  it('returns ungrouped for a member with no position', () => {
    expect(displayRole({ church_role: ChurchRole.Member, group_position: null })).toBe(
      DisplayRole.Ungrouped,
    );
  });
});

describe('canPromoteToLeadership', () => {
  it('allows core members', () => {
    expect(canPromoteToLeadership(GroupPosition.CoreMember)).toBe(true);
  });

  it('allows existing leaders', () => {
    expect(canPromoteToLeadership(GroupPosition.Leader)).toBe(true);
  });

  it('rejects regular members', () => {
    expect(canPromoteToLeadership(GroupPosition.RegularMember)).toBe(false);
  });

  it('rejects null', () => {
    expect(canPromoteToLeadership(null)).toBe(false);
  });
});

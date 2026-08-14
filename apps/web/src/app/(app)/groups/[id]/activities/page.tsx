'use client';

import { useParams } from 'next/navigation';
import { ActivityLog } from '@/components/ActivityLog';

/**
 * A life group's 活动记录 (0030) — the same page a 幸福小组 gets, pointed at this
 * group's own records (rule G4). Life groups are a CORE surface, so unlike the
 * 幸福小组 half there is no module to switch it off.
 */
export default function GroupActivitiesPage() {
  const { id } = useParams<{ id: string }>();
  return <ActivityLog base={`/groups/${id}`} backHref={`/groups/${id}`} />;
}

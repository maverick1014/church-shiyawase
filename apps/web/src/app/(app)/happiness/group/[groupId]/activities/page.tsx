'use client';

import { useParams } from 'next/navigation';
import { ActivityLog } from '@/components/ActivityLog';
import { useModuleEnabled } from '@/lib/church';
import { useT } from '@/lib/i18n';
import { MODULE_HAPPINESS } from '@tog/shared';

/**
 * A 幸福小组's 活动记录 (0029) — a thin route around the shared `<ActivityLog />`
 * (rule G4). Everything the page DOES lives in that component; this file only
 * says which records it is looking at, where Back goes, and that this half of
 * the feature belongs to a switchable module.
 */
export default function HappinessActivitiesPage() {
  const { groupId } = useParams<{ groupId: string }>();
  const t = useT();
  const happinessOn = useModuleEnabled(MODULE_HAPPINESS);

  return (
    <ActivityLog
      base={`/happiness/groups/${groupId}`}
      backHref={`/happiness/group/${groupId}`}
      disabled={!happinessOn}
      disabledName={t('module.happiness.name')}
    />
  );
}

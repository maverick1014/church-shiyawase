'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { useFetch } from '@/lib/hooks';
import { usePageChrome } from '@/components/AppShell';
import { Card, ErrorBanner, Loading } from '@/components/ui';
import { EventRow, MemberRow, OverviewRow, ProgramRow } from '@/lib/types';
import {
  eventBadgeClass,
  eventTypeKey,
  formatDateTime,
  memberRole,
  roleDot,
  roleKey,
  roleTagStyle,
  ROLE_ORDER,
} from '@/lib/labels';
import { useT } from '@/lib/i18n';
import { MemberStatus } from '@tog/shared';

export default function DashboardPage() {
  const t = useT();
  usePageChrome({ title: t('dash.title'), subtitle: t('dash.subtitle') }, [t]);

  const members = useFetch<MemberRow[]>('/members');
  const events = useFetch<EventRow[]>('/events');
  const programs = useFetch<ProgramRow[]>('/discipleship/programs');
  const firstProgram = programs.data?.[0]?.id;
  const overview = useFetch<OverviewRow[]>(
    firstProgram ? `/discipleship/programs/${firstProgram}/overview` : null,
  );

  const loading = members.initialLoading || events.initialLoading;
  const error = members.error || events.error;

  const memberList = members.data ?? [];
  const overviewList = overview.data ?? [];

  const activeCount = memberList.filter((m) => m.status === MemberStatus.Active).length;

  const upcoming = useMemo(
    () =>
      (events.data ?? [])
        .filter((e) => new Date(e.starts_at) >= new Date())
        .sort((a, b) => +new Date(a.starts_at) - +new Date(b.starts_at)),
    [events.data],
  );

  const activePairs = overviewList.filter((o) => Number(o.percent_complete) < 100).length;

  const roleChart = useMemo(() => {
    const counts: Record<string, number> = {};
    ROLE_ORDER.forEach((r) => (counts[r] = 0));
    for (const m of memberList) {
      const r = memberRole(m);
      if (counts[r] != null) counts[r]++;
    }
    const max = Math.max(1, ...Object.values(counts));
    return ROLE_ORDER.map((r) => ({
      key: r,
      label: t(roleKey(r)),
      count: counts[r],
      width: `${(counts[r] / max) * 100}%`,
      // The role's dot colour at ~65% alpha — same palette as the badges but
      // with real presence (the pale tag background alone was too faint).
      fill: `${roleDot(r)}A6`,
      fg: roleTagStyle(r).color,
    }));
  }, [memberList, t]);

  const discFocus = useMemo(
    () =>
      [...overviewList]
        .sort((a, b) => Number(a.percent_complete) - Number(b.percent_complete))
        .slice(0, 5),
    [overviewList],
  );

  const kpis = [
    { label: t('dash.kpi.members'), value: memberList.length, suffix: t('dash.unit.people') },
    { label: t('dash.kpi.active'), value: activeCount, suffix: t('dash.unit.people') },
    { label: t('dash.kpi.events'), value: upcoming.length, suffix: t('dash.unit.events') },
    { label: t('dash.kpi.discipleship'), value: activePairs, suffix: t('dash.unit.pairs') },
  ];

  if (loading) return <Loading />;

  return (
    <>
      <ErrorBanner message={error} />

      <div className="grid g4">
        {kpis.map((k) => (
          <div className="stat" key={k.label}>
            <div className="label">{k.label}</div>
            <div className="value">
              {k.value}
              {k.suffix && <span className="unit">{k.suffix}</span>}
            </div>
          </div>
        ))}
      </div>

      <div className="grid g2-wide mt-16">
        <Card
          title={t('dash.roleChart')}
          right={<span className="muted" style={{ fontSize: 12 }}>{t('dash.memberTotal', { n: memberList.length })}</span>}
        >
          {roleChart.map((r) => (
            <div
              key={r.key}
              style={{
                display: 'grid',
                gridTemplateColumns: '96px 1fr 34px',
                alignItems: 'center',
                gap: 12,
                padding: '5px 0',
              }}
            >
              <div style={{ fontSize: 12.5 }}>{r.label}</div>
              <div style={{ height: 22, borderRadius: 6, background: 'var(--surface-2)', overflow: 'hidden' }}>
                <div style={{ height: '100%', borderRadius: 6, width: r.width, background: r.fill }} />
              </div>
              <div style={{ fontSize: 13, fontWeight: 600, textAlign: 'right', color: r.count ? r.fg : 'var(--muted)' }} className="tnum">
                {r.count}
              </div>
            </div>
          ))}
        </Card>

        <Card
          title={t('dash.upcoming')}
          right={
            <Link className="muted" href="/events" style={{ fontSize: 12, fontWeight: 600 }}>
              {t('dash.viewAll')}
            </Link>
          }
        >
          {upcoming.length === 0 ? (
            <p className="faint" style={{ fontSize: 13 }}>{t('dash.noUpcoming')}</p>
          ) : (
            upcoming.slice(0, 5).map((e) => (
              <div key={e.id} className="flex items-center gap-10 flex-wrap" style={{ padding: '11px 0', borderBottom: '1px solid var(--border)' }}>
                <span className={`badge ${eventBadgeClass(e.event_type)}`}>
                  {t(eventTypeKey(e.event_type))}
                </span>
                <strong style={{ fontSize: 13 }}>{e.title}</strong>
                <div className="grow" />
                <span className="muted" style={{ fontSize: 12.5, whiteSpace: 'nowrap' }}>
                  {formatDateTime(e.starts_at)}{e.location ? ` · ${e.location}` : ''}
                </span>
              </div>
            ))
          )}
        </Card>
      </div>

      <div className="mt-16">
        <Card
          title={t('dash.discProgress')}
          right={
            <Link className="muted" href="/discipleship" style={{ fontSize: 12, fontWeight: 600 }}>
              {t('dash.pastorOverview')}
            </Link>
          }
        >
          {discFocus.length === 0 ? (
            <p className="faint" style={{ fontSize: 13 }}>{t('dash.noDisc')}</p>
          ) : (
            discFocus.map((d) => (
              <div key={d.pair_id} className="flex items-center gap-12" style={{ padding: '9px 0', borderBottom: '1px solid var(--border)' }}>
                <div className="grow" style={{ fontSize: 13 }}>
                  {d.trainee_name} <span className="faint">← {d.mentor_name}</span>
                </div>
                <div className="flex items-center gap-10" style={{ width: 150 }}>
                  <div className="bar thin">
                    <span style={{ width: `${d.percent_complete}%` }} />
                  </div>
                  <span className="muted tnum" style={{ fontSize: 12, minWidth: 34 }}>
                    {d.days_completed}/{d.total_days}
                  </span>
                </div>
              </div>
            ))
          )}
        </Card>
      </div>
    </>
  );
}

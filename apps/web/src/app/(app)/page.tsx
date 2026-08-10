'use client';

import { useMemo, useState } from 'react';
import { useFetch } from '@/lib/hooks';
import { usePageChrome, useMe } from '@/components/AppShell';
import { Card, ErrorBanner, Skeleton, SkeletonScreen, SkeletonTable } from '@/components/ui';
import { EventRow, MemberRow } from '@/lib/types';
import { formatDateTime } from '@/lib/labels';
import { monthlyVisitAndActiveTrend } from '@/lib/dashboard';
import { useT } from '@/lib/i18n';
import { AccountRole, MemberStatus, ChurchRole } from '@tog/shared';

/** Trailing months the trend chart covers. */
const TREND_MONTHS = 6;

export default function DashboardPage() {
  const t = useT();
  usePageChrome({ title: t('dash.title') }, [t]);

  // `events` is NOT in a group_leader's allowed API prefixes (`events/services
  // roll call` is out of its scope entirely) — `GET /members` narrows to its
  // own group on its own (server-side), so that half of the dashboard needs
  // no page-specific change, but `/events` would otherwise 403 on every load
  // and paint a scary error banner where the upcoming-events table goes.
  const isGroupLeader = useMe().role === AccountRole.GroupLeader;
  const members = useFetch<MemberRow[]>('/members');
  const events = useFetch<EventRow[]>(isGroupLeader ? null : '/events');

  const [showVisits, setShowVisits] = useState(true);
  const [showActive, setShowActive] = useState(true);

  const loading = members.initialLoading || (!isGroupLeader && events.initialLoading);
  const error = members.error || (isGroupLeader ? null : events.error);

  const memberList = members.data ?? [];

  // Excludes visitors, for the same headline definition of "active member"
  // this page uses everywhere else on it (the trend's own Active Members
  // series makes the same exclusion, right below).
  const activeCount = memberList.filter(
    (m) => m.status === MemberStatus.Active && m.church_role !== ChurchRole.Visitor,
  ).length;

  const trend = useMemo(
    () => monthlyVisitAndActiveTrend(memberList, TREND_MONTHS),
    [memberList],
  );

  const upcoming = useMemo(
    () =>
      (events.data ?? [])
        .filter((e) => new Date(e.starts_at) >= new Date())
        .sort((a, b) => +new Date(a.starts_at) - +new Date(b.starts_at))
        .slice(0, 5),
    [events.data],
  );

  // The page is three sections now: the trend chart, the upcoming-events
  // table, and one KPI tile — the skeleton lays out exactly that, in the
  // same trend-card-beside-KPI-tile grid the real render uses.
  if (loading)
    return (
      <SkeletonScreen>
        <div className="grid g2-wide">
          <div className="card" aria-hidden="true">
            <div className="card-head">
              <Skeleton width="42%" height={16} />
              <Skeleton width={160} height={26} radius={999} />
            </div>
            <Skeleton height={220} radius={10} />
          </div>
          <div className="stat">
            <Skeleton width={120} height={11} />
            <Skeleton width={64} height={28} style={{ marginTop: 10 }} />
          </div>
        </div>
        <div className="mt-16">
          <SkeletonTable rows={5} columns={3} />
        </div>
      </SkeletonScreen>
    );

  return (
    <>
      <ErrorBanner message={error} />

      {/* The trend chart and the one KPI tile read as a matched pair — the
          headline number the chart's own Active Members line is building
          toward, beside it rather than stranded alone under a full-width
          table (rule G4: the existing `.g2-wide` grid utility, unused until
          now, is exactly this 1.4fr/1fr split — collapsing to one column at
          the same breakpoint every other two-up layout in this app already
          does, so the mobile order is unchanged: chart, then KPI). */}
      <div className="grid g2-wide">
        <TrendCard trend={trend} showVisits={showVisits} showActive={showActive} onToggleVisits={() => setShowVisits((v) => !v)} onToggleActive={() => setShowActive((v) => !v)} />
        <div className="stat">
          <div className="label">{t('dash.kpi.totalActive')}</div>
          <div className="value">{activeCount}</div>
        </div>
      </div>

      <div className="mt-16">
        <UpcomingEventsCard events={upcoming} />
      </div>
    </>
  );
}

/**
 * A. The "New Visits" vs "Active Members" line chart — hand-rolled SVG, like
 * every other chart in this codebase (there is no charting library here and
 * this does not add one). Two independent toggle chips, reusing this app's
 * own chip pattern (the state filters on `/discipleship`) rather than
 * inventing new toggle markup (rule G4); both default on.
 */
function TrendCard({
  trend,
  showVisits,
  showActive,
  onToggleVisits,
  onToggleActive,
}: {
  trend: { month: string; visits: number; active: number }[];
  showVisits: boolean;
  showActive: boolean;
  onToggleVisits: () => void;
  onToggleActive: () => void;
}) {
  const t = useT();

  const svgW = 640;
  const svgH = 220;
  const padL = 30;
  const padR = 12;
  const padT = 14;
  const padB = 26;
  const plotW = svgW - padL - padR;
  const plotH = svgH - padT - padB;

  const visible = [
    ...(showVisits ? trend.map((p) => p.visits) : []),
    ...(showActive ? trend.map((p) => p.active) : []),
  ];
  const maxVal = Math.max(1, ...visible);

  const xFor = (i: number) => (trend.length <= 1 ? padL + plotW / 2 : padL + (i / (trend.length - 1)) * plotW);
  const yFor = (v: number) => padT + plotH - (v / maxVal) * plotH;

  const pointsFor = (key: 'visits' | 'active') =>
    trend.map((p, i) => `${xFor(i)},${yFor(p[key])}`).join(' ');
  // The area beneath a line is the same points closed off along the
  // baseline, so it fills the actual shape under the curve rather than a
  // rectangle down to zero at each end.
  const areaFor = (key: 'visits' | 'active') =>
    `${padL},${padT + plotH} ${pointsFor(key)} ${svgW - padR},${padT + plotH}`;

  const nothingSelected = !showVisits && !showActive;
  // Three even gridlines (not at the baseline, which already has its own
  // axis line below) — a reading aid, not a value anyone needs to read
  // precisely off a pixel.
  const gridFractions = [0.25, 0.5, 0.75];

  return (
    <Card
      title={t('dash.trend.title')}
      right={
        <div className="flex gap-6 flex-wrap">
          <button className={`chip ${showVisits ? 'on' : ''}`} onClick={onToggleVisits} aria-pressed={showVisits}>
            {/* Chip.on's own fill is this same --brand, so the dot has to
                invert to white there — same trick the chip's text already
                uses — or the "New Visits" swatch vanishes into its own
                background the instant it is selected. */}
            <i style={{ width: 8, height: 8, borderRadius: '50%', background: showVisits ? '#fff' : 'var(--brand)', display: 'inline-block' }} />
            {t('dash.trend.visits')}
          </button>
          <button className={`chip ${showActive ? 'on' : ''}`} onClick={onToggleActive} aria-pressed={showActive}>
            <i style={{ width: 8, height: 8, borderRadius: '50%', background: showActive ? '#fff' : 'var(--accent)', display: 'inline-block' }} />
            {t('dash.trend.active')}
          </button>
        </div>
      }
    >
      {nothingSelected ? (
        <p className="faint" style={{ fontSize: 13 }}>{t('dash.trend.empty')}</p>
      ) : (
        <svg
          viewBox={`0 0 ${svgW} ${svgH}`}
          style={{ width: '100%', height: 220, display: 'block' }}
          preserveAspectRatio="none"
          role="img"
          aria-label={t('dash.trend.title')}
        >
          <defs>
            <linearGradient id="dashTrendVisits" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--brand)" stopOpacity="0.16" />
              <stop offset="100%" stopColor="var(--brand)" stopOpacity="0" />
            </linearGradient>
            <linearGradient id="dashTrendActive" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.16" />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
            </linearGradient>
          </defs>
          {gridFractions.map((f) => (
            <line
              key={f}
              x1={padL}
              y1={padT + plotH * f}
              x2={svgW - padR}
              y2={padT + plotH * f}
              stroke="var(--border)"
              strokeWidth="1"
              strokeDasharray="3 4"
            />
          ))}
          <line x1={padL} y1={padT + plotH} x2={svgW - padR} y2={padT + plotH} stroke="var(--border)" strokeWidth="1" />
          {showVisits && <polygon points={areaFor('visits')} fill="url(#dashTrendVisits)" stroke="none" />}
          {showActive && <polygon points={areaFor('active')} fill="url(#dashTrendActive)" stroke="none" />}
          {showVisits && (
            <polyline points={pointsFor('visits')} fill="none" stroke="var(--brand)" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
          )}
          {showActive && (
            <polyline points={pointsFor('active')} fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
          )}
          {showVisits &&
            trend.map((p, i) => (
              <circle key={`v-${p.month}`} cx={xFor(i)} cy={yFor(p.visits)} r={3} fill="var(--surface)" stroke="var(--brand)" strokeWidth="2" />
            ))}
          {showActive &&
            trend.map((p, i) => (
              <circle key={`a-${p.month}`} cx={xFor(i)} cy={yFor(p.active)} r={3} fill="var(--surface)" stroke="var(--accent)" strokeWidth="2" />
            ))}
          {trend.map((p, i) => (
            <text key={p.month} x={xFor(i)} y={svgH - 8} fontSize="10" textAnchor="middle" fill="var(--muted)">
              {p.month.slice(5)}
            </text>
          ))}
        </svg>
      )}
    </Card>
  );
}

/**
 * B. The next 5 upcoming events, as an actual table — desktop table + mobile
 * tile fallback, the same split every list in this app uses (rule G7).
 */
function UpcomingEventsCard({ events }: { events: EventRow[] }) {
  const t = useT();
  return (
    <Card title={t('dash.upcoming')}>
      {events.length === 0 ? (
        <p className="faint" style={{ fontSize: 13 }}>{t('dash.noUpcoming')}</p>
      ) : (
        <>
          <div className="table-wrap only-desktop">
            <table className="table-fixed">
              <thead>
                <tr>
                  <th>{t('events.field.date')}</th>
                  <th>{t('events.field.title')}</th>
                  <th>{t('events.field.location')}</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id}>
                    <td className="muted tnum">{formatDateTime(e.starts_at)}</td>
                    <td>{e.title}</td>
                    <td className="muted">{e.location ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="only-mobile">
            {events.map((e) => (
              <div key={e.id} className="mtile">
                <div className="mtile-row1">
                  <strong style={{ fontSize: 13 }}>{e.title}</strong>
                </div>
                <div className="mtile-line">
                  {formatDateTime(e.starts_at)}
                  {e.location ? ` · ${e.location}` : ''}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </Card>
  );
}

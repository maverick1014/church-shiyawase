'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useFetch } from '@/lib/hooks';
import { usePageChrome } from '@/components/AppShell';
import {
  ErrorBanner,
  MemberName,
  RowChevron,
  Skeleton,
  SkeletonCard,
  SkeletonScreen,
  SkeletonTable,
} from '@/components/ui';
import { sundayPulse, groupHealthRollup, type SundayPoint } from '@/lib/dashboard';
import { formatDate, formatDateTime, groupHealthClass, groupHealthKey, trainingKindKey } from '@/lib/labels';
import { DashboardResponse } from '@/lib/types';
import { useT } from '@/lib/i18n';
import type { MessageKey } from '@/lib/i18n/en';

/** Sundays the pulse chart covers. The follow-up window is always four. */
const TREND_SUNDAYS = 8;
/** Most follow-up rows drawn before the list defers to the members page. */
const FOLLOW_UP_SHOWN = 6;

/**
 * The home page (0130) — pastoral, not analytical.
 *
 * It used to show how many member ROWS existed plus a growth curve the code
 * itself admitted was not a real historical reconstruction, and it ignored
 * attendance entirely — which is what the rest of this app is built around.
 * Four questions now, in the order a church actually asks them:
 *
 *   上主日   how many came, and is that up or down
 *   需要关怀 who has stopped coming (the one section that is a to-do, not a report)
 *   本周     what is on in the next seven days
 *   小组概况 how the life groups look
 *
 * One request feeds all four (`GET /api/dashboard`): the counting happens
 * server-side, past the same hall/group gate as every other read, so a
 * `group_leader` gets this same page narrowed to its own group rather than the
 * special-casing the old page needed to hide a section it could not read.
 */
export default function DashboardPage() {
  const t = useT();
  const data = useFetch<DashboardResponse>(`/dashboard?sundays=${TREND_SUNDAYS}`);

  usePageChrome({ title: t('dash.title') }, [t]);

  const d = data.data;
  const pulse = useMemo(() => sundayPulse(d?.sundays ?? []), [d?.sundays]);
  const health = useMemo(() => groupHealthRollup(d?.groups ?? []), [d?.groups]);

  if (data.initialLoading)
    return (
      <SkeletonScreen>
        {/* Laid out as the real page is, so nothing jumps when it lands. */}
        <div className="grid g2-wide">
          <SkeletonCard lines={2} />
          <SkeletonCard lines={3} />
        </div>
        <div className="mt-16">
          <SkeletonTable rows={4} columns={3} />
        </div>
      </SkeletonScreen>
    );

  return (
    <>
      <ErrorBanner message={data.error} />

      <div className="grid g2-wide">
        <SundayPulseCard points={d?.sundays ?? []} pulse={pulse} activeMembers={d?.active_members ?? 0} />
        <FollowUpCard rows={d?.follow_up ?? []} weeks={(d?.follow_up_sundays ?? []).length} />
      </div>

      <div className="grid g2-wide mt-16">
        <UpcomingCard rows={d?.upcoming ?? []} />
        <GroupHealthCard health={health} total={(d?.groups ?? []).length} />
      </div>
    </>
  );
}

/**
 * 上主日 — the church's pulse: last Sunday's turnout, how it compares, and the
 * shape of the Sundays behind it.
 *
 * The sparkline is hand-rolled SVG, like every other chart here (there is no
 * charting library in this codebase and it does not gain one for a dashboard).
 */
function SundayPulseCard({
  points,
  pulse,
  activeMembers,
}: {
  points: SundayPoint[];
  pulse: ReturnType<typeof sundayPulse>;
  activeMembers: number;
}) {
  const t = useT();
  const { latest, delta } = pulse;
  // What the average was ACTUALLY taken over — `sundayPulse` drops the leading
  // run of Sundays from before the church ever marked one, so counting the
  // window here would overstate it (and did, on the church's real data).
  const comparedTo = pulse.sampled;

  return (
    <div className="card">
      <div className="card-head">
        <h3>{t('dash.sunday.title')}</h3>
        <span className="muted" style={{ fontSize: 12.5 }}>
          {latest ? formatDate(latest.date) : ''}
        </span>
      </div>

      {!latest ? (
        <div className="empty">{t('dash.sunday.none')}</div>
      ) : (
        <>
          <div className="pulse-stats">
            <div className="pulse-stat lead">
              <div className="label">{t('dash.sunday.service')}</div>
              <div className="value">{latest.service}</div>
            </div>
            <div className="pulse-stat">
              <div className="label">{t('dash.sunday.preService')}</div>
              <div className="value">{latest.preService}</div>
            </div>
            <div className="pulse-stat">
              <div className="label">{t('dash.kpi.totalActive')}</div>
              <div className="value">{activeMembers}</div>
            </div>
          </div>

          <div className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>
            {delta === null
              ? t('dash.sunday.noAverage')
              : delta > 0
                ? t('dash.sunday.up', { n: delta, w: comparedTo })
                : delta < 0
                  ? t('dash.sunday.down', { n: Math.abs(delta), w: comparedTo })
                  : t('dash.sunday.same', { w: comparedTo })}
          </div>

          <Sparkline points={points} />
          <div className="faint" style={{ fontSize: 11.5, marginTop: 6 }}>
            {t('dash.sunday.trend', { n: points.length })}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The Sundays behind the headline, as bars.
 *
 * Bars rather than a line: these are counts of separate occasions, not samples
 * of a continuous quantity, and a line between two Sundays implies values in
 * between it that do not exist.
 */
function Sparkline({ points }: { points: SundayPoint[] }) {
  if (points.length === 0) return null;
  const peak = Math.max(...points.map((p) => p.service), 1);
  return (
    <>
      <div className="spark" style={{ marginTop: 14 }}>
        {points.map((p) => (
          <div key={p.date} className="spark-col">
            {/* Every bar carries its own count. A bare shape answers "up or
                down" but not "up or down from WHAT", and a phone has no hover
                to fall back on — which is exactly what the church asked. */}
            <span className="spark-n">{p.service}</span>
            <div
              className="spark-bar"
              style={{ height: `${Math.round((p.service / peak) * 100)}%` }}
            />
          </div>
        ))}
      </div>
      {/* MM-DD under each bar, so the run of empty weeks is dated rather than
          mysterious. The year is the same across the window and adds nothing. */}
      <div className="spark" style={{ height: 'auto', alignItems: 'flex-start' }}>
        {points.map((p) => (
          <div key={p.date} className="spark-col" style={{ height: 'auto' }}>
            <span className="spark-d">{p.date.slice(5)}</span>
          </div>
        ))}
      </div>
    </>
  );
}

/**
 * 需要关怀 — the only section here that is a to-do rather than a report.
 *
 * Longest-absent first, and capped: a church with a bad month should not get a
 * home page that is one enormous list. The rest are on `/members`, which is
 * where following any of them up actually happens.
 */
function FollowUpCard({
  rows,
  weeks,
}: {
  rows: DashboardResponse['follow_up'];
  weeks: number;
}) {
  const t = useT();
  const router = useRouter();
  const shown = rows.slice(0, FOLLOW_UP_SHOWN);

  return (
    <div className="card">
      <div className="card-head">
        <h3>{t('dash.followUp.title')}</h3>
        <span className="badge b-warn">{rows.length}</span>
      </div>
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 10 }}>
        {t('dash.followUp.sub', { w: weeks })}
      </div>

      {rows.length === 0 ? (
        <div className="empty-inline">{t('dash.followUp.none')}</div>
      ) : (
        <>
          {shown.map((m) => (
            <div key={m.id} className="mtile" onClick={() => router.push(`/members/${m.id}`)}>
              <div className="mtile-row1">
                <MemberName member={m} />
                <span className="mtile-cta"><RowChevron title="" onClick={() => router.push(`/members/${m.id}`)} /></span>
              </div>
              <div className="mtile-line">
                {m.last_seen
                  ? t('dash.followUp.lastSeen', { date: formatDate(m.last_seen) })
                  : t('dash.followUp.notInWindow', { w: weeks })}
                {m.group_name ? ` · ${m.group_name}` : ''}
              </div>
            </div>
          ))}
          {rows.length > shown.length && (
            <button className="btn ghost sm mt-8" onClick={() => router.push('/members')}>
              {t('dash.followUp.more', { n: rows.length - shown.length })}
            </button>
          )}
        </>
      )}
    </div>
  );
}

/**
 * 即将举行 — the next three months, not the next seven days.
 *
 * The church prepares an event about three months ahead (their words), so a
 * seven-day window showed an empty card almost every week and hid the thing
 * they were actually working on. 聚会 and 培训/活动 share the list: to somebody
 * reading this card they answer the same question, and split into two they
 * would just be two short cards that are usually empty.
 */
function UpcomingCard({ rows }: { rows: DashboardResponse['upcoming'] }) {
  const t = useT();
  const router = useRouter();
  // A meeting lives on /events; a 培训/活动 has its own page.
  const hrefOf = (r: DashboardResponse['upcoming'][number]) =>
    r.kind === 'meeting' ? '/events' : `/trainings/${r.id}`;

  return (
    <div className="card">
      <div className="card-head">
        <h3>{t('dash.upcoming')}</h3>
      </div>
      {rows.length === 0 ? (
        <div className="empty-inline">{t('dash.noUpcoming')}</div>
      ) : (
        rows.map((r) => (
          <div key={`${r.kind}-${r.id}`} className="mtile" onClick={() => router.push(hrefOf(r))}>
            <div className="mtile-row1">
              <strong style={{ minWidth: 0 }}>{r.title}</strong>
              <div className="flex items-center gap-8" style={{ flexShrink: 0 }}>
                <span className="badge b-gray">{t(upcomingKindKey(r.kind))}</span>
                <span className="mtile-cta"><RowChevron title="" onClick={() => router.push(hrefOf(r))} /></span>
              </div>
            </div>
            <div className="mtile-line">
              {/* A meeting carries a real timestamp; a 培训/活动 carries a bare
                  DATE plus its own optional start time. */}
              {r.kind === 'meeting'
                ? formatDateTime(r.at)
                : [formatDate(r.at), r.time?.slice(0, 5)].filter(Boolean).join(' ')}
              {r.location ? ` · ${r.location}` : ''}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

/**
 * The one tag an upcoming row carries: what KIND of thing it is. A 培训/活动
 * reuses `trainingKindKey` rather than restating those two labels here (G4/G8);
 * only "meeting" is this card's own word.
 */
function upcomingKindKey(kind: 'meeting' | 'course' | 'activity'): MessageKey {
  return kind === 'meeting' ? 'dash.upcoming.meeting' : trainingKindKey(kind);
}

/**
 * 小组概况 — how the life groups sit, as the chips `/groups` already filters by.
 *
 * Keyed by the STORED status code (rule G8), so the chips are
 * language-independent and each one lands on the same filter the groups page
 * reads.
 */
function GroupHealthCard({
  health,
  total,
}: {
  health: ReturnType<typeof groupHealthRollup>;
  total: number;
}) {
  const t = useT();
  const router = useRouter();
  return (
    <div className="card">
      <div className="card-head">
        <h3>{t('dash.groups.title')}</h3>
        <span className="muted" style={{ fontSize: 12.5 }}>{total}</span>
      </div>
      {total === 0 ? (
        <div className="empty-inline">{t('dash.groups.none')}</div>
      ) : (
        <div className="flex gap-8 flex-wrap">
          {health.map((b) => (
            <button
              key={b.status}
              className={`badge ${groupHealthClass(b.status)}`}
              style={{ border: 'none', cursor: 'pointer', fontSize: 12.5, padding: '6px 12px' }}
              onClick={() => router.push('/groups')}
            >
              {t(groupHealthKey(b.status))} · {b.count}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

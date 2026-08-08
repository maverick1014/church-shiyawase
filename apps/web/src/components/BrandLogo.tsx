import { ChurchProfile } from '@/lib/types';

/**
 * The church's brand mark. Rendered on a light "badge" so a dark logo reads
 * clearly, including on the dark sidebar.
 *
 * The image and the alt text come from the church RECORD (`logo_url` / `name`,
 * uploaded in 教会设置) — the church is data now, not a hardcoded string. The
 * bundled /logo.png is the fallback for a church that has not uploaded one,
 * and while the record is still loading the alt is empty rather than a guess.
 */
export function BrandLogo({
  size = 34,
  church,
}: {
  size?: number;
  church?: ChurchProfile | null;
}) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={church?.logo_url || '/logo.png'}
      alt={church?.name ?? ''}
      width={size}
      height={size}
      style={{ objectFit: 'contain', display: 'block' }}
    />
  );
}

/**
 * The church brand logo (transparent PNG). Rendered on a light "badge" so the
 * dark globe + crimson cross read clearly, including on the dark sidebar.
 */
export function BrandLogo({ size = 34 }: { size?: number }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/logo.png"
      alt="Tabernacle of Grace"
      width={size}
      height={size}
      style={{ objectFit: 'contain', display: 'block' }}
    />
  );
}

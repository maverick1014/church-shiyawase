import type { MetadataRoute } from 'next';

/**
 * Web App Manifest — makes the site installable (Add to Home Screen) as a
 * standalone app with the church logo. Next serves this at
 * /manifest.webmanifest and injects the <link rel="manifest"> automatically.
 *
 * The manifest is static, so it uses the app's default language (Chinese —
 * `DEFAULT_LANGUAGE` in packages/shared) regardless of the language an
 * individual account has chosen — and, for the same reason, the church name
 * below is a build-time literal rather than the `church` record every screen
 * inside the app reads from: a manifest is generated once at build time, with
 * no request and no database. It is the one place (with the <title> in
 * app/layout.tsx) where the church is still baked in per deployment.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Tabernacle of Grace · Church Management',
    short_name: 'Tabernacle of Grace',
    description: 'Members · events · trainings · forty-day one-to-one discipleship',
    lang: 'zh',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#f6f3f2',
    theme_color: '#a51f24',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}

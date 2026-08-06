import type { MetadataRoute } from 'next';

/**
 * Web App Manifest — makes the site installable (Add to Home Screen) as a
 * standalone app with the church logo. Next serves this at
 * /manifest.webmanifest and injects the <link rel="manifest"> automatically.
 *
 * The manifest is static, so it uses the app's default language (English)
 * regardless of the language an individual account has chosen.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Tabernacle of Grace · Church Management',
    short_name: 'Tabernacle of Grace',
    description: 'Members · events · trainings · forty-day one-to-one discipleship',
    lang: 'en',
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

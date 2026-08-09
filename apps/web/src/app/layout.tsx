import type { Metadata, Viewport } from 'next';
import './globals.css';
import { PWARegister } from '@/components/PWARegister';
import { THEME_BOOT_SCRIPT } from '@/lib/theme';

// Document metadata is rendered before any session exists, so it uses the
// app's default language (English) rather than the signed-in account's.
//
// The church name here is STILL A LITERAL, on purpose and unlike everywhere
// else in the app: `metadata` is evaluated at BUILD time, where there is no
// request, no session and no database connection, so it cannot read the
// `church` record the rest of the UI now renders from (see /church). Anything
// a visitor sees in the page itself — the sign-in card, the sidebar, the
// public forms — comes from that record; only the browser-tab title, the
// iOS home-screen name and the manifest (app/manifest.ts, same reason) are
// baked in per deployment.
export const metadata: Metadata = {
  title: 'Tabernacle of Grace · Church Management',
  description: 'Members · events · trainings · forty-day one-to-one discipleship',
  manifest: '/manifest.webmanifest',
  applicationName: 'Tabernacle of Grace',
  appleWebApp: {
    capable: true,
    title: 'Tabernacle of Grace',
    statusBarStyle: 'default',
  },
  // Favicon (app/icon.png) and apple-touch-icon (app/apple-icon.png) are wired
  // automatically by Next's file conventions; PWA icons live in the manifest.
};

// The church's chosen brand colour, like its name, is on a record this file
// cannot read at build time. So this is the DEFAULT: `applyTheme` (and the
// pre-paint script below) rewrite the rendered <meta name="theme-color"> from
// the record as soon as it is known.
export const viewport: Viewport = {
  themeColor: '#a51f24',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh">
      <head>
        {/* The church's two theme colours, applied BEFORE the first paint from
            the pair this device last saw, so a themed church does not flash
            the default palette while `GET /api/church` is in flight. It reads
            localStorage only — no request, nothing to block on — and validates
            what it finds before it touches a custom property. See lib/theme.ts
            for what the first-ever visit does instead. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body>
        {children}
        <PWARegister />
      </body>
    </html>
  );
}

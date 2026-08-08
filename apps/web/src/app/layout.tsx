import type { Metadata, Viewport } from 'next';
import './globals.css';
import { PWARegister } from '@/components/PWARegister';

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
    <html lang="en">
      <body>
        {children}
        <PWARegister />
      </body>
    </html>
  );
}

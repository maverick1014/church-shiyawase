import type { Metadata, Viewport } from 'next';
import './globals.css';
import { PWARegister } from '@/components/PWARegister';

// Document metadata is rendered before any session exists, so it uses the
// app's default language (English) rather than the signed-in account's.
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

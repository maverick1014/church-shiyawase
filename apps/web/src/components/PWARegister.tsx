'use client';

import { useEffect } from 'react';

/**
 * Registers the service worker so the app is installable on mobile
 * (Add to Home Screen). Renders nothing; mounted once in the root layout.
 */
export function PWARegister() {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const register = () => navigator.serviceWorker.register('/sw.js').catch(() => {});
    if (document.readyState === 'complete') register();
    else {
      window.addEventListener('load', register, { once: true });
      return () => window.removeEventListener('load', register);
    }
  }, []);
  return null;
}

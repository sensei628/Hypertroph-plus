import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Register the offline service worker for the installable PWA (production only).
// The desktop (Electron) shell ships its assets locally and handles offline
// itself, so a service worker there would only add cache-staleness risk.
const isDesktopApp = typeof window !== 'undefined' && !!window.desktop;
if (!isDesktopApp && import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* offline caching is best-effort */
    });
  });
}

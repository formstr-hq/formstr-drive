import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { isNativePlatform } from './utils/platform'
import { bootstrapDataLayer } from './dataLayer/bootstrap'

// Spawn the local-relay worker + DataLayer before anything renders — every
// relay read/write in the app goes through it.
bootstrapDataLayer()

// Powers the large-file streaming download fallback (src/services/swStreamDownload.ts)
// for browsers without the File System Access API. Not needed inside the
// Android WebView, which streams natively instead.
if (!isNativePlatform && "serviceWorker" in navigator && window.isSecureContext) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch((error) => {
      console.warn("Failed to register download service worker", error);
    });
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

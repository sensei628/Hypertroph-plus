import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.hypertrophplus',
  appName: 'hypertroph+',
  webDir: 'dist',
  // The whole app is bundled into the native shell and runs offline; no remote
  // server, no live reload in production. `https` scheme keeps the WebView on a
  // secure origin so the sql.js WASM and service worker behave like the web build.
  android: {
    allowMixedContent: false,
  },
  server: {
    androidScheme: 'https',
    iosScheme: 'https',
  },
};

export default config;

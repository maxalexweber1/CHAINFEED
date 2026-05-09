import type { NextConfig } from 'next';
import { resolve } from 'node:path';

const config: NextConfig = {
  // Pin file-tracing root to this app/ directory. Without it Next picks
  // up the parent CHAINFEED package-lock.json and emits a workspace warning.
  outputFileTracingRoot: resolve(__dirname),
  // The CHAINFEED CAP server runs on a different port than this app.
  // Configurable via NEXT_PUBLIC_CHAINFEED_BASE_URL at build / runtime
  // (read inside src/lib/chainfeed-client.ts).
  reactStrictMode: true,
  // ISR / revalidate is set per-page in route handlers.

  // Enable WebAssembly support — `@emurgo/cardano-serialization-lib-browser`
  // ships a .wasm module for the CSL crypto. Webpack 5 (used by Next under
  // the hood) requires opting into asyncWebAssembly to load .wasm imports.
  // The CSL package is dynamically imported in src/lib/cip30.ts so it only
  // shows up on the /demo route bundle, not the public dashboard.
  webpack: (cfg) => {
    cfg.experiments = { ...cfg.experiments, asyncWebAssembly: true, layers: true };
    return cfg;
  },
};

export default config;

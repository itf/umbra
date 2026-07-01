import { defineConfig, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { cpSync, existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Copy the committed `assets/` tree (HRTF binary, audio, icons) verbatim into the
 * build output as `dist/assets/…`. The app references these by a plain runtime URL
 * (`/assets/hrtf/sadie_h3.hrtf`), NOT a Vite `import … ?url`, so Vite doesn't know
 * to emit them — without this, the production build ships no HRTF and ALL spatial
 * audio fails (the page's index.html is served in its place). `vite dev` works
 * because it serves the project root directly; only the build needed this.
 */
function copyAssets(): Plugin {
  return {
    name: 'copy-runtime-assets',
    apply: 'build',
    closeBundle() {
      const src = resolve(__dirname, 'assets');
      const out = resolve(__dirname, 'dist/assets');
      if (!existsSync(src)) return;
      // Ship the baked .hrtf the default engine loads. The raw .sofa is normally the
      // 11 MB build-time source (`bake-hrtf` converts it to the 5.5 MB .hrtf), so we
      // skip OTHER .sofa files — but the SADIE SOFA the optional Steam path feeds to
      // Steam Audio's custom-HRTF API must ship, since Steam consumes SOFA directly.
      cpSync(src, out, {
        recursive: true,
        filter: (p) => !p.endsWith('.sofa') || p.endsWith('sadie_h3_48k.sofa'),
      });
    },
  };
}

/**
 * Make the vendored Steam Audio AudioWorklet's STATIC SIBLING IMPORT resolve in the
 * production build. The worklet (`steam-audio-processor.js`) begins with a bare
 * relative ES import:
 *
 *     import createSteamAudioModule from './bindings/phonon_bindings.js'
 *
 * Vite/Rollup discovers the worklet only through `new URL('./steam-audio-processor.js',
 * import.meta.url)` + `audioWorklet.addModule(...)`, so it COPIES the worklet verbatim
 * as a build asset WITHOUT following (and re-emitting) the worklet's own imports. The
 * worklet therefore ships referencing `/assets/bindings/phonon_bindings.js`, a path that
 * doesn't exist → the SPA host returns index.html (HTML) → the worklet's module load
 * fails with `SyntaxError: expected expression, got '<'` at phonon_bindings.js:1:1 → the
 * `steam-audio-processor` processor never registers → `createWorld` traps with
 * "indirect call to null", and `?engine=steam` silently falls back to our HRTF engine.
 * (Curl-verified: GET /assets/bindings/phonon_bindings.js → 200 text/html before this fix.)
 *
 * Fix: after the bundle is written, copy the vendored `dist/bindings/` (the standalone
 * Emscripten glue `phonon_bindings.js`, its `.wasm`, and `.d.ts`) into
 * `dist/assets/bindings/` so the worklet's hard-coded `./bindings/phonon_bindings.js`
 * import resolves to real JS. The worklet receives the WASM as an in-memory `wasmBinary`
 * (no fetch), so only the JS is strictly required — we copy the .wasm too as a harmless
 * fallback for the glue's `new URL('phonon_bindings.wasm', import.meta.url)` path.
 */
function vendorSteamWorkletBindings(): Plugin {
  return {
    name: 'vendor-steam-worklet-bindings',
    apply: 'build',
    closeBundle() {
      const src = resolve(__dirname, 'vendor/three-steam-audio/dist/bindings');
      const out = resolve(__dirname, 'dist/assets/bindings');
      if (!existsSync(src)) return;
      cpSync(src, out, { recursive: true });
    },
  };
}

/**
 * Emit a GitHub Pages SPA `404.html`. Pages has no server-side rewrite, so a HARD
 * load of a client route (e.g. /umbra/play — a refresh, bookmark, or shared link)
 * hits the server, finds no such file, and would 404. Pages serves `404.html` for
 * any missing path, so we make it a tiny redirect that rewrites the requested path
 * into a query segment and bounces to the app root (/umbra/?/play). The inline
 * decoder in index.html's <head> restores the real path via history.replaceState
 * BEFORE the router boots. (rafgraph/spa-github-pages technique.)
 *
 * `pathSegmentsToKeep` = number of leading path segments that are the base, not the
 * route — 1 for base `/umbra/`, 0 for a root-domain base `/`. Derived from the
 * resolved base so a future domain change (BASE_PATH) stays correct automatically.
 */
function spaPages404(base: string): Plugin {
  const segmentsToKeep = base.split('/').filter(Boolean).length; // '/umbra/' → 1, '/' → 0
  return {
    name: 'spa-pages-404',
    apply: 'build',
    closeBundle() {
      const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Umbra</title>
    <script>
      // Single Page Apps for GitHub Pages — rafgraph/spa-github-pages (MIT).
      // Rewrite /umbra/play → /umbra/?/play so the app can restore the route.
      var pathSegmentsToKeep = ${segmentsToKeep};
      var l = window.location;
      l.replace(
        l.protocol + '//' + l.hostname + (l.port ? ':' + l.port : '') +
        l.pathname.split('/').slice(0, 1 + pathSegmentsToKeep).join('/') + '/?/' +
        l.pathname.slice(1).split('/').slice(pathSegmentsToKeep).join('/').replace(/&/g, '~and~') +
        (l.search ? '&' + l.search.slice(1).replace(/&/g, '~and~') : '') +
        l.hash
      );
    </script>
  </head>
  <body></body>
</html>
`;
      writeFileSync(resolve(__dirname, 'dist/404.html'), html);
    },
  };
}

/**
 * SPA deep-link fallback for the MAIN app's client routes (/play, /level/<id>,
 * /progress, /about, /credits, …). The app is a multi-page build (main / debug /
 * editor / trainer), so Vite's built-in singleton SPA fallback isn't enough — and
 * `vite dev` / `vite preview` would 404 a hard reload on /level/foo. This middleware
 * rewrites navigation requests for unknown, extension-less paths to index.html so the
 * client router can take over, while leaving the OTHER HTML entries (debug.html,
 * editor.html, trainer.html), real asset files, and Vite's own internals alone.
 *
 * NOTE: for a production HOST (Cloudflare Pages / Netlify / etc.) the same rule must
 * exist there (e.g. a redirect of /* → /index.html 200, excluding the other .html
 * pages and /assets). The VitePWA `navigateFallback` below covers the offline/PWA case.
 */
function spaFallback(): Plugin {
  const OTHER_PAGES = ['/debug', '/editor', '/trainer'];
  const rewrite = (url: string | undefined): boolean => {
    if (!url) return false;
    const path = url.split('?')[0].split('#')[0];
    // Leave Vite internals, real files (anything with a dot → has an extension), and
    // the sibling HTML pages alone; only rewrite clean app-route paths.
    if (path.startsWith('/@') || path.startsWith('/node_modules') || path.startsWith('/src')) {
      return false;
    }
    if (path.startsWith('/assets') || path.startsWith('/vendor')) return false;
    if (path.includes('.')) return false; // has a file extension → serve as-is
    if (OTHER_PAGES.some((p) => path === p || path.startsWith(`${p}/`))) return false;
    return true; // /, /play, /level/foo, /progress, /about, /credits …
  };
  return {
    name: 'spa-deep-link-fallback',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.method === 'GET' && rewrite(req.url)) req.url = '/index.html';
        next();
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.method === 'GET' && rewrite(req.url)) req.url = '/index.html';
        next();
      });
    },
  };
}

export default defineConfig(({ command }) => {
  // Deployed to GitHub Pages under the repo-name sub-path (the itf/umbra repo is
  // served at itf.github.io/umbra/, surfaced as https://ivanaf.com/umbra/ via the
  // account's existing custom domain). A production BUILD must therefore prefix
  // every emitted URL with `/umbra/`; `vite dev` stays at `/` so local dev is
  // unchanged. Runtime asset fetches mirror this via src/engine/baseUrl.ts
  // (import.meta.env.BASE_URL), and the SPA 404.html derives its segment count from it.
  //
  // FUTURE DOMAIN CHANGE: to serve at a different path (e.g. its own domain at
  // root), build with `BASE_PATH=/ npm run build` — the env var overrides the
  // default with no code change. Must start and end with '/'.
  const base = command === 'build' ? (process.env.BASE_PATH ?? '/umbra/') : '/';
  return {
    base,
  // AudioWorklet + WASM both need to be served with correct MIME and cross-origin
  // isolation is helpful for high-resolution timers used in acoustics profiling.
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  // `vite preview` (and any production host) MUST send the same cross-origin
  // isolation headers: Steam Audio's threaded reflection sim needs SharedArrayBuffer,
  // which is gated behind COOP/COEP (`crossOriginIsolated === true`). Without these,
  // `?engine=steam` fails to init and falls back to our engine. Our own engine does
  // NOT need this, so default builds are unaffected. NOTE: the DEPLOYED app must also
  // send these headers from its host (e.g. a `_headers` file on Cloudflare Pages /
  // Netlify, or the PWA service worker) — the preview server only covers local checks.
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  worker: {
    format: 'es',
  },
  // Steam Audio (three-steam-audio) ships a worklet + worker + WASM that reference
  // sibling files via `new URL(..., import.meta.url)`. Vite's dep pre-bundler rewrites
  // those paths and breaks them (the worklet's transitive `import` and the WASM URL
  // resolve to index.html → "Unable to load a worklet's module" / bad WASM magic).
  // Excluding it from optimization keeps the package's own relative dist layout intact
  // so the worklet/worker/WASM load correctly. Only fetched on the ?engine=steam path.
  optimizeDeps: {
    exclude: ['three-steam-audio'],
  },
  build: {
    rollupOptions: {
      // Multi-page: the app shell + the audio debug view.
      input: {
        main: 'index.html',
        debug: 'debug.html',
        editor: 'editor.html',
        trainer: 'trainer.html',
      },
    },
  },
  plugins: [
    spaFallback(),
    copyAssets(),
    vendorSteamWorkletBindings(),
    spaPages404(base),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['assets/**/*'],
      manifest: {
        name: 'Umbra — learn to see with sound',
        short_name: 'Umbra',
        description:
          'Umbra — learn to see with sound. Human echolocation training: an audio-only game and echolocation trainer.',
        theme_color: '#000000',
        background_color: '#000000',
        display: 'standalone',
        orientation: 'portrait',
        icons: [
          { src: 'assets/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'assets/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'assets/icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // Client routing: an offline hard-load of /play, /level/x, /progress, /about
        // serves the app shell (index.html) so the SPA router can render. Exclude the
        // sibling multi-page HTML entries and asset paths so they resolve to their own
        // files, not the shell.
        navigateFallback: 'index.html',
        // Match at any path depth: under a deployed sub-path the request paths are
        // /umbra/assets/… , /umbra/debug.html , etc., so a leading-'/' anchor would
        // miss them. `(?:^|/)` matches at the root OR after the base prefix.
        navigateFallbackDenylist: [
          /(?:^|\/)(debug|editor|trainer)(\/|\.html|$)/,
          /(?:^|\/)assets\//,
          /(?:^|\/)vendor\//,
        ],
        // HRTF datasets and audio are large; precache app shell, runtime-cache the rest.
        globPatterns: ['**/*.{js,css,html,wasm}'],
        // Don't precache the LAZY Steam Audio path (three.js ~700 KB + the 6 MB phonon
        // WASM + its worker/processor). They load only on ?engine=steam via a dynamic
        // import, so the default player never needs them — precaching them wasted ~6.6 MB
        // (most of the precache) and slowed install. They're runtime-cached on first use.
        globIgnores: [
          '**/three.module-*.js',
          '**/phonon_bindings*.wasm',
          // The Emscripten glue copied next to the worklet (assets/bindings/) is part of
          // the lazy ?engine=steam path too — runtime-cache it, don't precache.
          '**/bindings/phonon_bindings.js',
          '**/steam-audio-processor-*.js',
          '**/reflection-simulator-worker-*.js',
          '**/world-*.js',
          '**/backend-*.js',
          '**/index-*.js',
        ],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        runtimeCaching: [
          {
            urlPattern: /\/assets\/(hrtf|audio)\/.*/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'audio-assets',
              expiration: { maxEntries: 64 },
            },
          },
        ],
      },
    }),
  ],
  // Several suites load the WASM acoustics core and/or node-web-audio-api native
  // audio contexts; running every test file in its own fork in parallel piled up
  // enough native memory to OOM the default heap. Cap the fork pool so memory
  // stays bounded — the suite is fast, so the small loss of parallelism is fine.
  test: {
    pool: 'forks',
    poolOptions: { forks: { maxForks: 4, minForks: 1 } },
    // The Playwright e2e specs live in e2e/ and must NOT be collected by vitest
    // (they call Playwright's test(), which throws under the vitest runner). They
    // run via `npm run e2e` instead.
    // `.claude/**` excludes any transient git worktrees the agent tooling creates
    // under .claude/worktrees/ — otherwise their copies of the specs get collected.
    exclude: ['e2e/**', 'node_modules/**', 'dist/**', '.claude/**', '**/.claude/**'],
    },
  };
});

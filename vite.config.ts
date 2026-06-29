import { defineConfig, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { cpSync, existsSync } from 'node:fs';
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
      // Ship everything EXCEPT the raw .sofa dataset — it's the 11 MB build-time
      // source that `bake-hrtf` converts into the 5.5 MB .hrtf the app loads.
      cpSync(src, out, { recursive: true, filter: (p) => !p.endsWith('.sofa') });
    },
  };
}

export default defineConfig({
  // AudioWorklet + WASM both need to be served with correct MIME and cross-origin
  // isolation is helpful for high-resolution timers used in acoustics profiling.
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  worker: {
    format: 'es',
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
    copyAssets(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['assets/**/*'],
      manifest: {
        name: 'Papa Sangre — Audio Navigator',
        short_name: 'AudioNav',
        description:
          'Navigate by sound alone. An audio-only game and echolocation trainer.',
        theme_color: '#000000',
        background_color: '#000000',
        display: 'standalone',
        orientation: 'portrait',
        icons: [
          { src: 'assets/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'assets/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
      workbox: {
        // HRTF datasets and audio are large; precache app shell, runtime-cache the rest.
        globPatterns: ['**/*.{js,css,html,wasm}'],
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
  },
});

import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

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

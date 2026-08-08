/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: './',
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'Arca',
        short_name: 'Arca',
        description: 'Convert documents, images, and audio to Markdown/text — 100% in your browser, nothing ever leaves your device.',
        theme_color: '#000000',
        background_color: '#000000',
        display: 'standalone',
        start_url: './',
        icons: [{ src: './favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/huggingface\.co\/.*/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'models-hf',
              cacheableResponse: { statuses: [0, 200] },
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 365 },
              rangeRequests: true
            }
          },
          {
            urlPattern: /^https:\/\/cdn\.jsdelivr\.net\/.*/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'models-cdn',
              cacheableResponse: { statuses: [0, 200] },
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 365 },
              rangeRequests: true
            }
          },
          {
            urlPattern: /^https:\/\/tessdata\.projectnaptha\.com\/.*/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'tessdata',
              cacheableResponse: { statuses: [0, 200] },
              expiration: { maxEntries: 40, maxAgeSeconds: 60 * 60 * 24 * 365 }
            }
          }
        ]
      }
    })
  ],
  build: {
    target: 'es2022',
    assetsInlineLimit: 0
  },
  worker: {
    format: 'es'
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts']
  }
});

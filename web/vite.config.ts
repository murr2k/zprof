import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

// Sferic is consumed from source (../../lightning/src) so the mockup can use
// renderer internals (RectBatch, SegmentBatch, SeriesXY) for its new chart types.
// Port 8781 is allocated in ~/.claude/port-registry.md.
const sfericSrc = fileURLToPath(new URL('../../lightning/src', import.meta.url))
const repoRoot = fileURLToPath(new URL('..', import.meta.url))

export default defineConfig({
  resolve: {
    alias: [
      { find: /^sferic$/, replacement: `${sfericSrc}/index.ts` },
      { find: /^sferic\/(.*)$/, replacement: `${sfericSrc}/$1` },
    ],
  },
  server: { port: 8781, strictPort: true, host: '127.0.0.1', fs: { allow: [repoRoot, sfericSrc] } },
  preview: { port: 8781, strictPort: true, host: '127.0.0.1' },
  build: { target: 'es2022', outDir: 'dist' },
})

import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { outDir, sharedPlugins } from './vite.shared.ts'

/** Side panel: React application (html entry). */
export default defineConfig({
  plugins: [react(), ...sharedPlugins],
  build: {
    outDir,
    emptyOutDir: false,
    rollupOptions: {
      input: resolve(import.meta.dirname, 'panel/index.html'),
      output: {
        entryFileNames: 'panel/assets/[name]-[hash].js',
        chunkFileNames: 'panel/assets/[name]-[hash].js',
        // Content-hashed asset names: Chrome may keep the previous stylesheet
        // for a fixed URL across extension reloads, which made UI edits look
        // unapplied; the hash changes the URL with the content.
        assetFileNames: 'panel/assets/[name]-[hash][extname]',
      },
    },
  },
})

export { outDir }

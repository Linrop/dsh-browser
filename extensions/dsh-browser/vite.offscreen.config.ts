import { copyManifest, outDir, targetBuild } from './vite.shared.ts'

/**
 * Offscreen keepalive document (Chrome only): an ES module page that messages
 * the service worker every 20 s. It appends to dist/ after the background
 * target has cleaned it, and emits no manifest of its own.
 */
export default targetBuild('src/offscreen/index.ts', 'es', 'offscreen.js', false)

export { copyManifest, outDir }

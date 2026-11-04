/**
 * Build all four extension targets sequentially into dist/ (or dist-firefox/
 * with --firefox):
 * background (es|iife) → offscreen keepalive (es) → content (iife) → panel
 * (React). The first target cleans the output; the later ones append. Pass
 * --watch for dev rebuilds.
 */

import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const watch = process.argv.includes('--watch')

// --firefox switches the manifest and background bundle for the Firefox build.
if (process.argv.includes('--firefox')) {
  process.env.EXT_TARGET = 'firefox'
}

const outDir = resolve(root, process.env.EXT_TARGET === 'firefox' ? 'dist-firefox' : 'dist')

/**
 * The offscreen page is a four-line document; generating it here keeps the
 * page and the emitted bundle side by side without a second source file. It
 * is written after the background target has cleaned the output directory.
 */
function writeOffscreenPage() {
  const html = [
    '<!doctype html>',
    '<meta charset="utf-8">',
    '<title>dsh browser bridge keepalive</title>',
    '<script type="module" src="offscreen.js"></script>',
    '',
  ].join('\n')
  mkdirSync(outDir, { recursive: true })
  writeFileSync(resolve(outDir, 'offscreen.html'), html)
}

const configs = [
  'vite.background.config.ts',
  'vite.offscreen.config.ts',
  'vite.content.config.ts',
  'vite.panel.config.ts',
]

if (watch) {
  // 三个 watcher 并行启动（串行时第一个永不停机，后面的永远不会启动）。
  const children = configs.map((config) => spawn('vite', ['build', '--config', config, '--watch'], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  }))
  for (const child of children) {
    child.on('exit', (code) => { if (code !== 0) process.exit(code ?? 1) })
  }
  // The background watcher cleans the output directory at its first build;
  // write the page after that window instead of racing it.
  setTimeout(writeOffscreenPage, 5_000)
} else {
  for (const config of configs) {
    const result = spawnSync('vite', ['build', '--config', config], {
      cwd: root,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
    if (result.status !== 0) process.exit(result.status ?? 1)
  }
  writeOffscreenPage()
}

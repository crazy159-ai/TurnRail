import { defineConfig, type Plugin } from 'vite'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'

const root = fileURLToPath(new URL('.', import.meta.url))

/** 将 manifest.json 与 icons/ 复制进 dist，使 dist 目录可直接作为 unpacked extension 加载 */
function copyExtensionStatic(): Plugin {
  return {
    name: 'copy-extension-static',
    apply: 'build',
    closeBundle() {
      const dist = resolve(root, 'dist')
      mkdirSync(dist, { recursive: true })
      copyFileSync(resolve(root, 'manifest.json'), resolve(dist, 'manifest.json'))
      const iconsDir = resolve(root, 'icons')
      if (existsSync(iconsDir)) {
        const outIcons = resolve(dist, 'icons')
        mkdirSync(outIcons, { recursive: true })
        for (const file of readdirSync(iconsDir)) {
          copyFileSync(resolve(iconsDir, file), resolve(outIcons, file))
        }
      }
    }
  }
}

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome114',
    sourcemap: false,
    minify: 'esbuild',
    lib: {
      entry: resolve(root, 'src/content/main.ts'),
      name: 'TurnRail',
      formats: ['iife'],
      fileName: () => 'content.js'
    }
  },
  plugins: [copyExtensionStatic()]
})

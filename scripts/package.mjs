#!/usr/bin/env node
/**
 * 跨平台发布打包（Windows / Linux / macOS / CI 通用，替代 Windows-only 的
 * powershell Compress-Archive）：
 *
 *   1. 校验 package.json 与 manifest.json 版本一致
 *   2. 检查 dist/ 存在（npm run package 会自动先执行 build）
 *   3. 用 archiver 将 dist/ 内容打包为 release/turnrail-v<version>.zip
 *      —— ZIP 根目录即扩展根目录（解压直接 Load unpacked），不嵌套外层目录
 *   4. 打包后用 adm-zip 复核 ZIP 实际内容：必须含 manifest.json / content.js / icons/，
 *      禁止混入 src/ test/ node_modules/ package.json 等
 *
 * 仅打包扩展运行时文件；archiver / adm-zip 均为 devDependency，不进入扩展产物。
 */
import { createWriteStream, existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import archiver from 'archiver'
import AdmZip from 'adm-zip'

const root = fileURLToPath(new URL('..', import.meta.url))

function fail(message) {
  console.error(`[package] ${message}`)
  process.exit(1)
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(root, path), 'utf8'))
}

const pkg = readJson('package.json')
const manifest = readJson('manifest.json')
if (pkg.version !== manifest.version) {
  fail(`版本不一致: package.json=${pkg.version} manifest.json=${manifest.version}`)
}

const distDir = resolve(root, 'dist')
const distManifest = resolve(distDir, 'manifest.json')
const distContent = resolve(distDir, 'content.js')
if (!existsSync(distManifest) || !existsSync(distContent)) {
  fail('dist/ 不完整（缺少 manifest.json 或 content.js）—— 请先执行 npm run build')
}

// dist/manifest.json 必须与源 manifest 一致（构建不改动关键 Cache/权限字段）
const distManifestJson = JSON.parse(readFileSync(distManifest, 'utf8'))
for (const field of ['version', 'manifest_version', 'permissions']) {
  if (JSON.stringify(distManifestJson[field]) !== JSON.stringify(manifest[field])) {
    fail(`dist/manifest.json 与源 manifest.json 字段不一致: ${field}`)
  }
}

const releaseDir = resolve(root, 'release')
const zipPath = resolve(releaseDir, `turnrail-v${pkg.version}.zip`)
await mkdir(releaseDir, { recursive: true })
await rm(zipPath, { force: true })

const iconsDir = resolve(distDir, 'icons')
if (!existsSync(iconsDir) || readdirSyncSafe(iconsDir).length === 0) {
  fail('dist/icons/ 缺失或为空 —— manifest.icons 引用的图标必须随 ZIP 发布')
}

/** 只打包 dist/ 内容，ZIP 根目录即扩展根目录 */
await new Promise((resolvePromise, rejectPromise) => {
  const output = createWriteStream(zipPath)
  const archive = archiver('zip', { zlib: { level: 9 } })
  output.on('close', resolvePromise)
  archive.on('error', rejectPromise)
  archive.pipe(output)
  archive.directory(distDir, false)
  archive.finalize().catch(rejectPromise)
})

// ---- 打包后复核 ZIP 实际内容（防止误打包 / 目录嵌套回归）----
const REQUIRED_ENTRIES = ['manifest.json', 'content.js']
const FORBIDDEN_PREFIXES = [
  'src/',
  'test/',
  'scripts/',
  'node_modules/',
  '.github/',
  'release/'
]
const FORBIDDEN_ENTRIES = [
  'package.json',
  'package-lock.json',
  'README.md',
  'CONTRIBUTING.md',
  'LICENSE',
  'tsconfig.json',
  'vite.config.ts'
]

const zip = new AdmZip(zipPath)
const entries = zip.getEntries().map((entry) => entry.entryName)
const missing = REQUIRED_ENTRIES.filter((name) => !entries.includes(name))
if (missing.length > 0) fail(`ZIP 缺少必需文件: ${missing.join(', ')}`)

const wrongTopLevel = entries.filter((name) => {
  if (name.startsWith('icons/')) return false
  return name.includes('/')
})
if (wrongTopLevel.length > 0) {
  fail(`ZIP 出现非 icons/ 的嵌套路径（顶层必须是扩展根）: ${wrongTopLevel.slice(0, 5).join(', ')}`)
}

const forbiddenHits = entries.filter(
  (name) =>
    FORBIDDEN_ENTRIES.includes(name) ||
    FORBIDDEN_PREFIXES.some((prefix) => name === prefix || name.startsWith(prefix))
)
if (forbiddenHits.length > 0) fail(`ZIP 混入禁止文件: ${forbiddenHits.join(', ')}`)

const iconEntries = entries.filter((name) => name.startsWith('icons/'))
if (iconEntries.length === 0) fail('ZIP 缺少 icons/')

const sizeKb = (statSync(zipPath).size / 1024).toFixed(2)
console.log(`[package] ${zipPath}`)
console.log(`[package] entries: ${entries.length}（icons: ${iconEntries.length}）, size: ${sizeKb} kB`)

function readdirSyncSafe(dir) {
  try {
    return readdir(dir)
  } catch {
    return []
  }
}

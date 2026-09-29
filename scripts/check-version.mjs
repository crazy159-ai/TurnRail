#!/usr/bin/env node
/**
 * 版本一致性检查：package.json.version 必须与 manifest.json.version 完全一致。
 * 供 `npm run check` 与 CI 使用；不一致时以非零退出码失败。
 *
 * 注意：Cache schemaVersion（CACHE_SCHEMA_VERSION）与扩展版本号是两件事，
 * 本脚本不涉及缓存 schema。
 */
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'))

if (pkg.version !== manifest.version) {
  console.error(
    `[check-version] 版本不一致: package.json=${pkg.version} manifest.json=${manifest.version}`
  )
  process.exitCode = 1
} else {
  console.log(`[check-version] version OK: ${pkg.version}`)
}

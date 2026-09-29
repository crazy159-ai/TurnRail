#!/usr/bin/env node
/**
 * Release tag 一致性检查：git tag（vX.Y.Z）必须与 package.json / manifest.json
 * 版本完全一致，否则 release 流水线失败。供 release.yml 在打包前调用。
 */
import { readFileSync } from 'node:fs'

const refName = process.env.GITHUB_REF_NAME ?? ''
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'))

const expected = `v${pkg.version}`
if (pkg.version !== manifest.version) {
  console.error(
    `[check-release-tag] 版本不一致: package.json=${pkg.version} manifest.json=${manifest.version}`
  )
  process.exitCode = 1
} else if (refName !== expected) {
  console.error(
    `[check-release-tag] tag 与版本不一致: tag=${refName || '(未设置 GITHUB_REF_NAME)'} ` +
      `但 package/manifest version=${pkg.version}（期望 tag=${expected}）`
  )
  process.exitCode = 1
} else {
  console.log(`[check-release-tag] tag ${refName} 与扩展版本 ${pkg.version} 一致`)
}

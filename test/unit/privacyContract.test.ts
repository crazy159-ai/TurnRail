import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * 隐私合同测试（Privacy Contract Tests，v1.2.1）：
 * 把 README「Privacy」章节的承诺变成自动回归门槛。
 * 任何一条失败 = privacy model 变化，必须单独 PR + 更新 README + 明确 rationale。
 */

const root = join(import.meta.dirname, '..', '..')

function readJson(path: string): any {
  return JSON.parse(readFileSync(join(root, path), 'utf8'))
}

// ---------------- manifest 合同 ----------------

const manifest = readJson('manifest.json')
const packageJson = readJson('package.json')

test('privacy/manifest: Manifest V3', () => {
  assert.equal(manifest.manifest_version, 3)
})

test('privacy/manifest: permissions 只允许 storage', () => {
  const ALLOWED = new Set(['storage'])
  const permissions: string[] = manifest.permissions ?? []
  assert.deepEqual(
    permissions.filter((p) => !ALLOWED.has(p)),
    [],
    `manifest 出现未批准权限: ${permissions.join(', ')}`
  )
  assert.ok(permissions.includes('storage'))
})

test('privacy/manifest: 禁止出现高危权限', () => {
  const FORBIDDEN = [
    'tabs',
    'activeTab',
    'scripting',
    'webNavigation',
    'cookies',
    'history',
    'webRequest',
    'declarativeNetRequest',
    'unlimitedStorage',
    'alarms',
    'nativeMessaging'
  ]
  const all: string[] = [
    ...(manifest.permissions ?? []),
    ...(manifest.host_permissions ?? []),
    ...(manifest.optional_permissions ?? [])
  ]
  const hits = all.filter((p) => FORBIDDEN.includes(p))
  assert.deepEqual(hits, [], `manifest 出现禁止权限: ${hits.join(', ')}`)
})

test('privacy/manifest: host 匹配只允许 chatgpt.com 两条', () => {
  const ALLOWED = new Set(['https://chatgpt.com/*', 'https://www.chatgpt.com/*'])
  const matches: string[] = (manifest.content_scripts ?? []).flatMap((cs: any) => cs.matches ?? [])
  assert.deepEqual(
    matches.filter((m) => !ALLOWED.has(m)),
    [],
    `content_scripts.matches 出现未批准 host: ${matches.join(', ')}`
  )
  assert.equal(matches.length, 2)

  const hostPermissions: string[] = manifest.host_permissions ?? []
  assert.deepEqual(
    hostPermissions.filter((m) => !ALLOWED.has(m)),
    [],
    `host_permissions 出现未批准 host: ${hostPermissions.join(', ')}`
  )
  // <all_urls> 绝不允许
  const allPatterns: string[] = [...matches, ...hostPermissions]
  assert.ok(!allPatterns.includes('<all_urls>'))
})

test('privacy/manifest: 无 background service worker / 无 web_accessible_resources 放大', () => {
  assert.equal(manifest.background, undefined)
  // content.js 由页面脚本标签加载（测试台），不需要 web_accessible
  assert.equal(manifest.web_accessible_resources, undefined)
  assert.equal(manifest.externally_connectable, undefined)
})

test('privacy/manifest: content script 只注入 content.js 且 document_end', () => {
  const scripts: any[] = manifest.content_scripts ?? []
  assert.equal(scripts.length, 1)
  assert.deepEqual(scripts[0]!.js, ['content.js'])
  assert.equal(scripts[0]!.run_at, 'document_end')
  assert.equal(scripts[0]!.all_frames, false)
})

// ---------------- 运行时无网络合同 ----------------

/** 收集 src/ 全部 .ts 文件（只扫运行时源码；测试代码 / README 不在约束内） */
function collectSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...collectSourceFiles(full))
    else if (entry.endsWith('.ts')) out.push(full)
  }
  return out
}

/**
 * 网络原语黑名单：合法调用形态的近似正则（\b 避免 prefetch 之类误报）。
 * 若未来出现真实例外，必须在本表显式登记（file + pattern + rationale），
 * 不允许静默绕过。
 */
const NETWORK_PATTERNS: { name: string; regex: RegExp }[] = [
  { name: 'fetch(', regex: /\bfetch\s*\(/ },
  { name: 'XMLHttpRequest', regex: /\bXMLHttpRequest\b/ },
  { name: 'WebSocket(', regex: /\bWebSocket\s*\(/ },
  { name: 'EventSource(', regex: /\bEventSource\s*\(/ },
  { name: 'navigator.sendBeacon(', regex: /\bsendBeacon\s*\(/ }
]

/** 显式白名单（当前为空）：出现真实例外时登记 { file, name, rationale } */
const NETWORK_EXCEPTIONS: { file: string; name: string; rationale: string }[] = []

test('privacy/network: src/ 运行时源码零网络原语', () => {
  const srcDir = join(root, 'src')
  const files = collectSourceFiles(srcDir)
  assert.ok(files.length >= 25, `src/ 应存在 TypeScript 源文件（实际 ${files.length}）`)

  const violations: string[] = []
  for (const file of files) {
    const rel = relative(root, file).replace(/\\/g, '/')
    const source = readFileSync(file, 'utf8')
    for (const { name, regex } of NETWORK_PATTERNS) {
      if (!regex.test(source)) continue
      const excepted = NETWORK_EXCEPTIONS.some((e) => e.file === rel && e.name === name)
      if (!excepted) violations.push(`${rel}: ${name}`)
    }
  }
  assert.deepEqual(
    violations,
    [],
    `运行时源码出现网络原语（= privacy model change，需单独 PR）: ${violations.join('; ')}`
  )
})

test('privacy/network: 合同测试自身可检出网络调用（防正则失效）', () => {
  // 自检：把模式套在含 fetch 调用的样本上必须命中，且 prefetch 不误报
  const samples: [string, boolean][] = [
    [`const r = await fetch(url)`, true],
    [`window.fetch('/api')`, true],
    [`this.prefetch(url)`, false],
    [`new WebSocket('wss://x')`, true],
    [`navigator.sendBeacon(endpoint)`, true],
    [`const ev = new EventSource('/sse')`, true],
    [`const xhr = new XMLHttpRequest()`, true]
  ]
  for (const [code, expected] of samples) {
    const hit = NETWORK_PATTERNS.some(({ regex }) => regex.test(code))
    assert.equal(hit, expected, `正则自检失败: ${code}`)
  }
})

// ---------------- 扩展版本一致性（发布合同） ----------------

test('privacy/manifest: package.json 与 manifest.json 版本一致', () => {
  assert.equal(packageJson.version, manifest.version)
})

// ---------------- Handoff 隐私合同（Handoff V1） ----------------

test('privacy/handoff: pending handoff 使用独立命名空间，绝不复用 cache index', async () => {
  const { PENDING_HANDOFF_KEY } = await import('../../src/handoff/types.ts')
  assert.equal(PENDING_HANDOFF_KEY.startsWith('turnrail:handoff:'), true)
  assert.notEqual(PENDING_HANDOFF_KEY, 'turnrail:cache:index')
})

test('privacy/handoff: pending TTL 为 5-15 分钟的产品窗口（非长期存储）', async () => {
  const { PENDING_HANDOFF_TTL_MS } = await import('../../src/handoff/types.ts')
  assert.ok(PENDING_HANDOFF_TTL_MS >= 5 * 60 * 1000, 'TTL 不得短于 5 分钟（可用性）')
  assert.ok(PENDING_HANDOFF_TTL_MS <= 15 * 60 * 1000, 'TTL 不得长于 15 分钟（隐私：短生命周期）')
})

test('privacy/handoff: handoff 模块零 console 输出（payload 绝不进控制台）', async () => {
  const handoffDir = join(root, 'src', 'handoff')
  const files = collectSourceFiles(handoffDir)
  assert.ok(files.length >= 5, `src/handoff 应存在全部模块（实际 ${files.length}）`)
  const violations: string[] = []
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    // 收集所有 console.* 调用（含注释外的真实调用）；handoff 模块一个都不应有
    if (/\bconsole\s*\.\s*(log|info|debug|warn|error|trace)\b/.test(source)) {
      violations.push(relative(root, file).replace(/\\/g, '/'))
    }
  }
  assert.deepEqual(
    violations,
    [],
    `handoff 模块出现 console 输出（payload 泄漏风险）: ${violations.join('; ')}`
  )
})

test('privacy/handoff: handoff 模块零网络原语（并入全仓扫描的自证）', async () => {
  // 全仓扫描已覆盖 src/handoff/（collectSourceFiles(src) 递归）；
  // 此处显式验证目录确实在扫描范围内，防止未来目录被排除
  const handoffDir = join(root, 'src', 'handoff')
  for (const file of collectSourceFiles(handoffDir)) {
    const source = readFileSync(file, 'utf8')
    for (const { name, regex } of NETWORK_PATTERNS) {
      assert.equal(regex.test(source), false, `${relative(root, file)} 出现 ${name}`)
    }
  }
})

test('privacy/handoff: composer selector 只存在于 Provider（边界合同）', async () => {
  // Handoff 注入所需的站点 selector（#prompt-textarea）只允许出现在 providers/；
  // handoff/ 与 ui/ 必须只依赖 capability 接口
  const offenders: string[] = []
  for (const dir of ['handoff', 'ui', 'content']) {
    for (const file of collectSourceFiles(join(root, 'src', dir))) {
      const source = readFileSync(file, 'utf8')
      if (source.includes('prompt-textarea')) offenders.push(relative(root, file).replace(/\\/g, '/'))
    }
  }
  assert.deepEqual(offenders, [], `composer selector 越界: ${offenders.join('; ')}`)
})

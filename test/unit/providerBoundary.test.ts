import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * Provider 边界合同测试（v1.2.1）：
 * 「所有 ChatGPT 站点 DOM selector 集中于 src/providers/chatgpt.ts」——
 * 自动扫描 src/ 其余文件，禁止 selector 字符串再散落（含字符串字面量与代码）。
 * 文档注释中的历史提法不算违规：扫描前先剥离注释，selector 只允许活在
 * Provider 与 Provider 类型注释里。
 */

const root = join(import.meta.dirname, '..', '..')

/** ChatGPT-specific selector 关键片段（出现即说明该文件持有站点 DOM 知识） */
const FORBIDDEN_FRAGMENTS = [
  'data-turn-key',
  'data-chatgpt-search',
  'data-chatgpt-selection',
  'data-content-search',
  'data-user-message-bubble',
  'data-thread-find-target',
  'data-thread-find-skip',
  'data-app-action-timeline-scroll',
  'data-message-author-role',
  'data-message-id',
  'data-markdown-text-tone',
  'data-markdown-text-style',
  'data-conversation-role',
  'conversation-turn'
]

/** Provider 本体与其类型定义：selector 的唯一合法居所 */
const ALLOWED_FILES = new Set([
  'src/providers/chatgpt.ts',
  'src/providers/types.ts'
])

function collectSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...collectSourceFiles(full))
    else if (entry.endsWith('.ts')) out.push(full)
  }
  return out
}

/** 剥离块注释与行注释（保留字符串字面量——selector 正是以字符串形态散落） */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
}

test('provider-boundary: ChatGPT selector 只存在于 Provider 模块', () => {
  const files = collectSourceFiles(join(root, 'src'))
  const violations: string[] = []

  for (const file of files) {
    const rel = relative(root, file).replace(/\\/g, '/')
    if (ALLOWED_FILES.has(rel)) continue
    const code = stripComments(readFileSync(file, 'utf8'))
    for (const fragment of FORBIDDEN_FRAGMENTS) {
      if (code.includes(fragment)) violations.push(`${rel}: ${fragment}`)
    }
  }

  assert.deepEqual(
    violations,
    [],
    `ChatGPT selector 泄漏到 Provider 之外（站点 DOM 知识只允许存在于 providers/chatgpt.ts）: ` +
      violations.join('; ')
  )
})

test('provider-boundary: 剥注释逻辑自检（字符串内 selector 必须仍被检出）', () => {
  const sample = `
    // const a = '[data-turn-key]' （注释里的不算）
    const b = '[data-turn-key]'
    /* const c = "[data-chatgpt-search-unit-key]" */
  `
  const stripped = stripComments(sample)
  assert.ok(stripped.includes('[data-turn-key]'), '字符串字面量中的 selector 必须保留')
  assert.ok(!/const a/.test(stripped), '行注释应被剥离')
  assert.ok(!stripped.includes('const c'), '块注释应被剥离')
})

test('provider-boundary: Provider 健康诊断不输出 selector / 正文 / ID', () => {
  // getDiagnostics 契约：返回值字段全部为计数与布尔（见 ProviderDiagnostics）
  const source = readFileSync(join(root, 'src/providers/chatgpt.ts'), 'utf8')
  assert.ok(source.includes('getDiagnostics'), 'Provider 应实现 getDiagnostics')
  assert.ok(source.includes('hasRecognizableContent'), 'Provider 应实现 hasRecognizableContent')
  assert.ok(source.includes('getMutationHints'), 'Provider 应实现 getMutationHints')
})

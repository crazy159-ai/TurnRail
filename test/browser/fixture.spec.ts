import { test, expect } from '@playwright/test'

/**
 * Browser Test 1：真实 DOM fixture（test/fixture/index.html）。
 * fixture 自带 tn-debug=1，1.5s 后在 window.__fixture 上公布断言结果。
 */
interface FixtureWindow {
  __fixture?: { ok: boolean; reason?: string; checks: [string, boolean, string][] }
  __tnDebug?: { storeTurns: number; markers: number }
}

test('fixture: 真实结构最小 fixture 完整解析并渲染 rail', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (err) => errors.push(String(err)))

  await page.goto('/test/fixture/index.html')

  await expect
    .poll(() => page.evaluate(() => (window as unknown as FixtureWindow).__fixture?.ok ?? null), {
      timeout: 20_000
    })
    .toBe(true)

  const checks = await page.evaluate(() => (window as unknown as FixtureWindow).__fixture?.checks ?? [])
  expect(checks.filter(([, ok]) => !ok)).toEqual([])

  // 附加检查：store 与 rail 同步（DEBUG 可得）
  const debug = await page.evaluate(() => ({
    storeTurns: (window as unknown as FixtureWindow).__tnDebug?.storeTurns ?? null,
    markers: (window as unknown as FixtureWindow).__tnDebug?.markers ?? null
  }))
  expect(debug.storeTurns).toBe(1)
  expect(debug.markers).toBe(1)

  // 诊断导出冒烟：版本正确、JSON 可解析、不含聊天正文（fixture 正文 "Hello"/"Hi"）
  const diag = await page.evaluate(async () => {
    const json = await (globalThis as any).__tn.copyDiagnostics()
    return { parsed: JSON.parse(json), json: json as string }
  })
  // 版本：扩展环境为 chrome.runtime.getManifest().version；
  // 测试台以普通 <script> 加载（无 chrome.runtime）→ 回退 'unknown'
  expect(diag.parsed.turnrailVersion).toMatch(/^(\d+\.\d+\.\d+|unknown)$/)
  expect(diag.parsed.navigation.storeTurns).toBe(1)
  expect(diag.json.includes('Hello')).toBe(false)
  expect(diag.json.includes('Hi"')).toBe(false)

  expect(errors, '页面不应出现 JS 错误').toEqual([])
})

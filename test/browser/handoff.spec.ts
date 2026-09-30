import { test, expect, type Page } from '@playwright/test'
import { gotoWithDebug, waitForMarkers } from './helpers'

const MOCK = '/test/mock/index.html'

/**
 * Conversation Handoff 浏览器冒烟（规格 #36 Browser A-J）：
 * checkpoint 标记 → Handoff 预览（含/不含内容边界）→ 取消/确认 →
 * 新聊天页自动填入 composer（绝不自动发送）→ pending 消费 →
 * streaming 不影响 checkpoint / handoff UI。
 *
 * 测试台说明：
 * - 注入可工作的 chrome.storage.local 桩（localStorage 后端，跨导航持久），
 *   模拟真实扩展的 storage 能力（cache miss 无影响；pending handoff 可跨页）；
 * - window.open 拦截为记录函数：验证"打开新聊天"意图但不真访问 chatgpt.com；
 *   新聊天页在同一 mock 内以 home 路由（无会话 id）模拟，与真实
 *   chatgpt.com/ 首页的注入条件（conversationId === null）一致。
 */

/** 注入可工作的 chrome.storage.local（localStorage 后端，跨导航持久） */
async function injectWorkingStorage(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const PREFIX = 'tn-stub:'
    const data = new Map<string, unknown>()
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)
        if (k && k.startsWith(PREFIX)) {
          try {
            data.set(k.slice(PREFIX.length), JSON.parse(localStorage.getItem(k) ?? 'null'))
          } catch {
            /* 忽略损坏记录 */
          }
        }
      }
    } catch {
      /* localStorage 不可用 */
    }
    const persist = (key: string, value: unknown): void => {
      try {
        localStorage.setItem(PREFIX + key, JSON.stringify(value ?? null))
      } catch {
        /* 忽略 */
      }
    }
    const stub = {
      get: async (key: string) => ({ [key]: data.get(key) }),
      set: async (items: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(items)) {
          data.set(k, v)
          persist(k, v)
        }
      },
      remove: async (key: string) => {
        data.delete(key)
        try {
          localStorage.removeItem(PREFIX + key)
        } catch {
          /* 忽略 */
        }
      }
    }
    try {
      ;(globalThis as Record<string, unknown>).chrome = { storage: { local: stub } }
    } catch {
      Object.defineProperty(globalThis, 'chrome', {
        configurable: true,
        value: { storage: { local: stub } }
      })
    }
  })
}

/**
 * 拦截 window.open：返回可导航的假窗口并记录"预留地址"与"最终导航地址"，
 * 不真打开外网。新聊天页在同一 mock 内以 home 路由（无会话 id）模拟，
 * 与真实 chatgpt.com/ 首页的注入条件（conversationId === null）一致。
 */
async function interceptWindowOpen(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const g = globalThis as Record<string, unknown>
    g.__tnOpenedUrl = null // window.open 的实参（预留 = about:blank）
    g.__tnNavigatedUrl = null // reservation.navigate() 写入的最终地址
    g.__tnReservationClosed = false
    window.open = ((url?: string | URL) => {
      g.__tnOpenedUrl = String(url ?? '')
      const win: Record<string, unknown> = {
        closed: false,
        opener: null,
        close() {
          win.closed = true
          g.__tnReservationClosed = true
        }
      }
      Object.defineProperty(win, 'location', {
        value: {
          get href() {
            return 'about:blank'
          },
          set href(value: string) {
            g.__tnNavigatedUrl = String(value)
          }
        }
      })
      return win as unknown as Window
    }) as unknown as typeof window.open
  })
}

/** 模拟浏览器弹窗拦截：window.open 恒返回 null（popup blocked） */
async function blockWindowOpen(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.open = (() => null) as typeof window.open
  })
}

/** 注入全故障 chrome.storage.local（模拟 extension context invalidated / storage 故障） */
async function injectFailingStorage(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const reject = (): Promise<never> => Promise.reject(new Error('Extension context invalidated.'))
    const stub = { get: reject, set: reject, remove: reject }
    try {
      ;(globalThis as Record<string, unknown>).chrome = { storage: { local: stub } }
    } catch {
      Object.defineProperty(globalThis, 'chrome', {
        configurable: true,
        value: { storage: { local: stub } }
      })
    }
  })
}

/**
 * 覆盖 navigator.clipboard.writeText（测试台 content.js 以页面脚本加载，
 * 与 main world 同上下文）：'ok' 恒成功 / 'reject' 恒失败，确定性地模拟
 * 真实 Chrome 的剪贴板权限授予与拒绝。
 */
async function overrideClipboard(page: Page, behavior: 'ok' | 'reject'): Promise<void> {
  await page.addInitScript((mode) => {
    const writeText =
      mode === 'ok'
        ? (): Promise<void> => Promise.resolve()
        : (): Promise<never> => Promise.reject(new Error('clipboard write denied'))
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText }
    })
  }, behavior)
}

async function pendingExists(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    try {
      return localStorage.getItem('tn-stub:turnrail:handoff:pending') !== null
    } catch {
      return false
    }
  })
}

async function openedUrl(page: Page): Promise<string | null> {
  return page.evaluate(() => (globalThis as Record<string, unknown>).__tnOpenedUrl as string | null)
}

async function navigatedUrl(page: Page): Promise<string | null> {
  return page.evaluate(() => (globalThis as Record<string, unknown>).__tnNavigatedUrl as string | null)
}

async function reservationClosed(page: Page): Promise<boolean> {
  return page.evaluate(
    () => (globalThis as Record<string, unknown>).__tnReservationClosed === true
  )
}

/** hover 轨道展开面板并等待列表项出现 */
async function openPanel(page: Page): Promise<void> {
  await page.locator('.tn-rail').hover()
  await expect(page.locator('.tn-item').first()).toBeVisible()
}

/** 标记第一轮为 checkpoint（☆→★），并断言入口按钮出现 */
async function starFirstTurn(page: Page): Promise<void> {
  await openPanel(page)
  const firstItem = page.locator('.tn-item').first()
  await firstItem.hover()
  const star = firstItem.locator('.tn-checkpoint-btn')
  await star.click()
  await expect(star).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.tn-handoff-open-btn')).toBeVisible()
}

async function openHandoffPreview(page: Page): Promise<string> {
  await openPanel(page)
  await page.locator('.tn-handoff-open-btn').click()
  const preview = page.locator('.tn-handoff-text')
  await expect(preview).toBeVisible()
  return preview.inputValue()
}

test('handoff A: checkpoint ☆→★ + 会话隔离（A→B 入口隐藏，B→A 恢复）', async ({ page }) => {
  await injectWorkingStorage(page)
  await gotoWithDebug(page, MOCK)
  await waitForMarkers(page, 12)

  await starFirstTurn(page)

  // SPA 切到 B：B 无 checkpoint → 入口隐藏
  await page.click('aside button[data-act="conv-b"]')
  await waitForMarkers(page, 8)
  await openPanel(page)
  await expect(page.locator('.tn-handoff-open-btn')).toBeHidden()
  await expect(page.locator('.tn-checkpoint-btn').first()).toHaveAttribute('aria-pressed', 'false')

  // 回 A：checkpoint 计数仍在 A 桶 → 入口恢复。
  // 注意 mock 的 loadConversationA() 每次重建 DOM 都生成新 turn UUID（真实 ChatGPT
  // 的 turn id 稳定），因此不断言旧 star 状态，只断言会话桶级隔离。
  await page.click('aside button[data-act="conv-a"]')
  await waitForMarkers(page, 12)
  await openPanel(page)
  await expect(page.locator('.tn-handoff-open-btn')).toBeVisible()
})

test('handoff B/C/D: 预览生成 —— 含 checkpoint 与目标轮，不含超范围旧轮', async ({ page }) => {
  await injectWorkingStorage(page)
  await gotoWithDebug(page, MOCK)
  await waitForMarkers(page, 12)

  await starFirstTurn(page) // Q1 → checkpoint
  await page.click('button[data-act="add60"]')
  await waitForMarkers(page, 72)

  const text = await openHandoffPreview(page)

  // B：预览可见且为完整 markdown 结构（用户必须先看到全部内容）
  expect(text).toContain('# TurnRail Context Handoff')
  expect(text).toContain('## Continuation Rules')
  expect(text).toContain('## Source')
  expect(text).toContain('## Selected Checkpoints')
  expect(text).toContain('## Recent Working Context')
  expect(text).toContain('## Current Objective')
  expect(text).toContain('## Next Action')

  // C：checkpoint 内容被保留（Q1 的“第 1 次提问”）
  expect(text).toContain('第 1 次提问')
  // 最新目标轮（Q72）作为 Current Objective
  expect(text).toContain('第 72 次提问')

  // D：未选中且超出 recent tail（最近 6 轮）的旧内容绝不出现
  expect(text).not.toContain('第 2 次提问')
  expect(text).not.toContain('第 65 次提问')

  // 无截断场景不显示 warning 区
  await expect(page.locator('.tn-handoff-warnings')).toBeHidden()
})

test('handoff E: 取消预览不产生 pending handoff', async ({ page }) => {
  await injectWorkingStorage(page)
  await gotoWithDebug(page, MOCK)
  await waitForMarkers(page, 12)

  await starFirstTurn(page)
  await openHandoffPreview(page)
  await page.locator('.tn-handoff-btn', { hasText: '取消' }).click()

  await expect(page.locator('.tn-handoff-text')).toBeHidden()
  expect(await pendingExists(page)).toBe(false)
})

test('handoff F: 确认继续 → 预留新标签页 + pending 创建 + 导航新聊天（不发送）', async ({ page }) => {
  await injectWorkingStorage(page)
  await interceptWindowOpen(page)
  await gotoWithDebug(page, MOCK)
  await waitForMarkers(page, 12)

  await starFirstTurn(page)
  const text = await openHandoffPreview(page)
  await page.locator('.tn-handoff-continue').click()

  // 同步预留 about:blank（正文不经 URL），pending 落盘后再导航到新聊天页
  await expect.poll(() => openedUrl(page)).toBe('about:blank')
  await expect.poll(() => navigatedUrl(page)).toBe('https://chatgpt.com/')
  // pending handoff 已落盘
  await expect.poll(() => pendingExists(page)).toBe(true)
  const stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('tn-stub:turnrail:handoff:pending') ?? 'null')
  )
  expect(stored.payload).toBe(text)
  // 预览关闭 + 明示"不会自动发送"
  await expect(page.locator('.tn-handoff-text')).toBeHidden()
  await expect(page.locator('.tn-status')).toContainText('不会自动发送')
})

test('handoff G/H/I: 新聊天页自动读取 pending → 填入 composer（不发送）→ 消费删除', async ({
  page
}) => {
  await injectWorkingStorage(page)
  await interceptWindowOpen(page)
  await gotoWithDebug(page, MOCK)
  await waitForMarkers(page, 12)

  await starFirstTurn(page)
  await openHandoffPreview(page)
  await page.locator('.tn-handoff-continue').click()
  await expect.poll(() => pendingExists(page)).toBe(true)

  // 模拟新标签页：重新加载（stub 从 localStorage 恢复 pending），初始仍为会话 A
  await page.goto(MOCK)
  await waitForMarkers(page, 12)
  expect(await pendingExists(page)).toBe(true) // 会话页不注入、不消费

  // 用户进入新聊天（home 路由 = 无会话 id，与 chatgpt.com/ 注入条件一致）
  await page.click('aside button[data-act="home"]')

  // G+H：handoff 自动填入 composer（只填草稿）
  const composer = page.locator('#prompt-textarea')
  await expect
    .poll(async () => (await composer.textContent()) ?? '', { timeout: 10_000 })
    .toContain('TurnRail Context Handoff')
  await expect(composer).toContainText('Current Objective')
  // 状态栏明示需要用户手动发送
  await expect(page.locator('.tn-status')).toContainText('手动发送')

  // I：pending 消费删除；再次路由不重复注入
  await expect.poll(() => pendingExists(page)).toBe(false)
  // 不自动发送：home 路由 thread 无任何 turn（rail 隐藏但 marker DOM 保留为既有行为）
  await expect(page.locator('[data-turn-key]')).toHaveCount(0)
})

test('handoff K: storage 失败 + clipboard 失败 → 状态绝不谎报"已复制"', async ({ page }) => {
  await injectFailingStorage(page)
  await overrideClipboard(page, 'reject')
  await interceptWindowOpen(page)
  await gotoWithDebug(page, MOCK)
  await waitForMarkers(page, 12)

  await starFirstTurn(page)
  await openHandoffPreview(page)
  await page.locator('.tn-handoff-continue').click()

  // 两条回退路径都失败：状态必须明确"无法自动传递 + 请手动复制"，绝不出现"已复制"。
  // 预留的空白标签页必须回滚关闭，不留孤儿 tab。
  const status = page.locator('.tn-status')
  await expect(status).toContainText('无法自动传递')
  await expect(status).toContainText('手动全选复制')
  await expect(status).not.toContainText('已复制')
  expect(await pendingExists(page)).toBe(false)
  expect(await reservationClosed(page)).toBe(true)
  // 预览保持打开，用户仍可手动全选复制
  await expect(page.locator('.tn-handoff-text')).toBeVisible()
})

test('handoff C3: storage 失败 + clipboard 成功 → 明示剪贴板兜底路径', async ({ page }) => {
  await injectFailingStorage(page)
  await overrideClipboard(page, 'ok')
  await interceptWindowOpen(page)
  await gotoWithDebug(page, MOCK)
  await waitForMarkers(page, 12)

  await starFirstTurn(page)
  await openHandoffPreview(page)
  await page.locator('.tn-handoff-continue').click()

  const status = page.locator('.tn-status')
  await expect(status).toContainText('已复制 Handoff')
  await expect(status).toContainText('手动打开新聊天并粘贴')
  expect(await pendingExists(page)).toBe(false)
})

test('handoff L: popup blocked → 绝不显示"已打开"，不创建 pending', async ({ page }) => {
  await injectWorkingStorage(page)
  await blockWindowOpen(page)
  await overrideClipboard(page, 'ok')
  await gotoWithDebug(page, MOCK)
  await waitForMarkers(page, 12)

  await starFirstTurn(page)
  await openHandoffPreview(page)
  await page.locator('.tn-handoff-continue').click()

  // 浏览器阻止新标签页：不显示"已打开"，pending 不创建，剪贴板兜底
  const status = page.locator('.tn-status')
  await expect(status).toContainText('浏览器阻止了新标签页')
  await expect(status).toContainText('已复制')
  await expect(status).not.toContainText('已打开')
  expect(await pendingExists(page)).toBe(false)
  // 预览保持打开，用户可手动复制或重试
  await expect(page.locator('.tn-handoff-text')).toBeVisible()
})

test('handoff L2: popup blocked + clipboard 失败 → 引导手动复制', async ({ page }) => {
  await injectWorkingStorage(page)
  await blockWindowOpen(page)
  await overrideClipboard(page, 'reject')
  await gotoWithDebug(page, MOCK)
  await waitForMarkers(page, 12)

  await starFirstTurn(page)
  await openHandoffPreview(page)
  await page.locator('.tn-handoff-continue').click()

  const status = page.locator('.tn-status')
  await expect(status).toContainText('浏览器阻止了新标签页')
  await expect(status).toContainText('手动全选复制')
  await expect(status).not.toContainText('已复制')
  await expect(status).not.toContainText('已打开')
  expect(await pendingExists(page)).toBe(false)
})

test('handoff C1: 复制按钮 clipboard 成功 → 明确成功提示', async ({ page }) => {
  await injectWorkingStorage(page)
  await overrideClipboard(page, 'ok')
  await gotoWithDebug(page, MOCK)
  await waitForMarkers(page, 12)

  await starFirstTurn(page)
  await openHandoffPreview(page)
  await page.locator('.tn-handoff-btn', { hasText: '复制' }).click()
  await expect(page.locator('.tn-status')).toContainText('已复制')
})

test('handoff C2: 复制按钮 clipboard 抛错 → 绝不显示成功', async ({ page }) => {
  await injectWorkingStorage(page)
  await overrideClipboard(page, 'reject')
  await gotoWithDebug(page, MOCK)
  await waitForMarkers(page, 12)

  await starFirstTurn(page)
  await openHandoffPreview(page)
  await page.locator('.tn-handoff-btn', { hasText: '复制' }).click()
  const status = page.locator('.tn-status')
  await expect(status).toContainText('复制失败')
  await expect(status).not.toContainText('已复制')
})

test('handoff J: assistant streaming 不影响 checkpoint 与 handoff UI', async ({ page }) => {
  await injectWorkingStorage(page)
  await gotoWithDebug(page, MOCK)
  await waitForMarkers(page, 12)

  await starFirstTurn(page)

  // 触发流式回复（assistant 高频 text 更新）
  await page.click('button[data-act="stream"]')
  await page.waitForTimeout(1500)

  // checkpoint 状态与 Handoff 入口在流式期间保持不变
  await openPanel(page)
  await expect(page.locator('.tn-checkpoint-btn').first()).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.tn-handoff-open-btn')).toBeVisible()

  // 流式后仍能正常生成预览且包含 checkpoint
  const text = await openHandoffPreview(page)
  expect(text).toContain('Selected Checkpoints')
  expect(text).toContain('第 1 次提问')
})

test('handoff: Health CTA 分档 —— 高风险对话出现 CTA 并可直达预览', async ({ page }) => {
  await injectWorkingStorage(page)
  await gotoWithDebug(page, MOCK)
  await waitForMarkers(page, 12)

  // 制造高上下文风险对话：8 轮显式纠错 prompt（"不对 / 重新做 / 改成方案 B"）
  // → correctionHits ≥ 4 → correctionFrequency 达 watch gate（0.8）→ health
  //   离开 healthy → CTA 显示。（绕过 addTurns 的 i%5 采样逻辑，确定性触发）
  await page.evaluate(() => {
    const mock = globalThis as unknown as {
      makeTurn: (userText: string, assistantText: string) => { root: HTMLElement }
    }
    const thread = document.querySelector('#thread')!
    for (let i = 0; i < 8; i++) {
      thread.appendChild(
        mock.makeTurn('前面不对，重新做，改成方案 B，继续之前的内容。', '这是对应的回答。').root
      )
    }
  })
  await waitForMarkers(page, 20)
  await openPanel(page)

  const cta = page.locator('.tn-health-cta')
  await expect(cta).toBeVisible()
  // 文案不声称知道真实上下文（隐私合同）
  const label = (await cta.textContent()) ?? ''
  expect(label.length).toBeGreaterThan(0)
  expect(label).not.toContain('上下文已满')
  expect(label).not.toContain('已遗忘')

  await cta.click()
  await expect(page.locator('.tn-handoff-text')).toBeVisible()
})

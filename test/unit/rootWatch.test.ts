import test from 'node:test'
import assert from 'node:assert/strict'
import { watchConversationRoot, type RootWatchTimers } from '../../src/content/observers.ts'

/**
 * RootWatch 生命周期（假时钟，不等待真实 30 秒）：
 * fast discovery（MutationObserver 缺席时由轮询兜底）→ 30s 超时 → 低频恢复
 * （10s probe + focus / visibilitychange 立即 probe）→ found / stop 终止。
 */

/** 手动推进的假时钟：记录全部 interval 与事件监听，按虚拟时间触发 */
function makeFakeTimers(): RootWatchTimers & {
  advance(ms: number): void
  fire(type: string): void
  intervalCount(): number
  listenerCount(): number
} {
  interface Slot {
    callback: () => void
    every: number
    next: number
  }
  const intervals: Slot[] = []
  const windowListeners = new Map<string, () => void>()
  const documentListeners = new Map<string, () => void>()
  let now = 0

  return {
    setInterval(callback, ms) {
      const slot: Slot = { callback, every: ms, next: now + ms }
      intervals.push(slot)
      return slot
    },
    clearInterval(handle) {
      const index = intervals.indexOf(handle as Slot)
      if (index >= 0) intervals.splice(index, 1)
    },
    addWindowListener(type, listener) {
      windowListeners.set(type, listener)
    },
    removeWindowListener(type) {
      windowListeners.delete(type)
    },
    addDocumentListener(type, listener) {
      documentListeners.set(type, listener)
    },
    removeDocumentListener(type) {
      documentListeners.delete(type)
    },
    advance(ms) {
      const target = now + ms
      // 逐毫步推进，保证触发顺序与真实定时器一致
      while (now < target) {
        now++
        for (const slot of [...intervals]) {
          if (now >= slot.next && intervals.includes(slot)) {
            slot.next += slot.every
            slot.callback()
          }
        }
      }
    },
    fire(type) {
      windowListeners.get(type)?.()
      documentListeners.get(type)?.()
    },
    intervalCount: () => intervals.length,
    listenerCount: () => windowListeners.size + documentListeners.size
  }
}

function makeProvider(rootRef: { current: HTMLElement | null }) {
  return { getConversationRoot: () => rootRef.current }
}

const el = () => ({ isConnected: true }) as unknown as HTMLElement

test('rootWatch: root 立即存在 → 同步回调，无任何定时器', () => {
  const timers = makeFakeTimers()
  let found: HTMLElement | null = null
  const stop = watchConversationRoot(makeProvider({ current: el() }), (root) => (found = root), undefined, {
    timers
  })
  assert.ok(found)
  assert.equal(timers.intervalCount(), 0)
  stop()
})

test('rootWatch: root 10 秒后出现 → 轮询发现并停止', () => {
  const timers = makeFakeTimers()
  const rootRef = { current: null as HTMLElement | null }
  let found: HTMLElement | null = null
  watchConversationRoot(makeProvider(rootRef), (root) => (found = root), undefined, { timers })

  timers.advance(9_500)
  assert.equal(found, null)

  rootRef.current = el()
  timers.advance(500)
  assert.ok(found)
  assert.equal(timers.intervalCount(), 0, '发现后停止全部定时器')
})

test('rootWatch: 30 秒超时 → onGiveUp 一次并进入低频恢复', () => {
  const timers = makeFakeTimers()
  const rootRef = { current: null as HTMLElement | null }
  let giveUps = 0
  watchConversationRoot(makeProvider(rootRef), () => {}, () => giveUps++, { timers })

  timers.advance(31_000)
  assert.equal(giveUps, 1)
  // 快速轮询已停止，恢复 interval 在跑
  assert.equal(timers.intervalCount(), 1)
  assert.equal(timers.listenerCount(), 2, 'focus + visibilitychange 监听')

  // 超时后快速轮询不再推进（继续 advance 不触发 onGiveUp 第二次）
  timers.advance(10_000)
  assert.equal(giveUps, 1)
})

test('rootWatch: 超时后低频 probe 找到 root → 回调并停止恢复', () => {
  const timers = makeFakeTimers()
  const rootRef = { current: null as HTMLElement | null }
  let found: HTMLElement | null = null
  let giveUps = 0
  watchConversationRoot(makeProvider(rootRef), (root) => (found = root), () => giveUps++, { timers })

  timers.advance(31_000)
  rootRef.current = el()
  timers.advance(10_000)
  assert.ok(found, '低频 probe 命中')
  assert.equal(timers.intervalCount(), 0, '命中后停止恢复 interval')
  assert.equal(timers.listenerCount(), 0, '命中后移除事件监听')
  assert.equal(giveUps, 1)
})

test('rootWatch: 超时后 focus / visibilitychange 立即 probe', () => {
  const timers = makeFakeTimers()
  const rootRef = { current: null as HTMLElement | null }
  let found: HTMLElement | null = null
  watchConversationRoot(makeProvider(rootRef), (root) => (found = root), undefined, { timers })

  timers.advance(31_000)
  rootRef.current = el()
  timers.fire('focus')
  assert.ok(found, 'focus 立即 probe 命中')
})

test('rootWatch: route change（stop）→ 恢复模式立即停止', () => {
  const timers = makeFakeTimers()
  const rootRef = { current: null as HTMLElement | null }
  let found: HTMLElement | null = null
  const stop = watchConversationRoot(makeProvider(rootRef), (root) => (found = root), undefined, {
    timers
  })

  timers.advance(31_000)
  assert.equal(timers.intervalCount(), 1)
  stop()
  assert.equal(timers.intervalCount(), 0, 'stop 清理恢复 interval')
  assert.equal(timers.listenerCount(), 0, 'stop 清理事件监听')

  rootRef.current = el()
  timers.advance(60_000)
  timers.fire('focus')
  assert.equal(found, null, '停止后不再发现')
})

test('rootWatch: recoveryProbeMs = 0 → 超时后彻底放弃（v1.2 旧行为）', () => {
  const timers = makeFakeTimers()
  const rootRef = { current: null as HTMLElement | null }
  let giveUps = 0
  watchConversationRoot(makeProvider(rootRef), () => {}, () => giveUps++, {
    timers,
    recoveryProbeMs: 0
  })

  timers.advance(31_000)
  assert.equal(giveUps, 1)
  assert.equal(timers.intervalCount(), 0, '无恢复 interval')
  assert.equal(timers.listenerCount(), 0)

  rootRef.current = el()
  timers.advance(60_000)
  assert.ok(true, '不崩溃即通过')
})

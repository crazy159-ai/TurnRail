import test from 'node:test'
import assert from 'node:assert/strict'
import {
  beginConversationTransition,
  isConversationDomReady,
  readConversationDomSignature,
  TRANSITION_PROBE_DELAYS,
  type ConversationDomSignature,
  type TransitionEvents,
  type TransitionTimers
} from '../../src/content/conversationTransition.ts'

/**
 * Conversation Transition Gate 契约测试（规格 #16–#24）：
 * 旧/新 DOM 签名比较、短生命周期退避、give-up 后事件恢复、probeNow、
 * ready 后立即停止。全部注入假时钟与假事件，零真实等待。
 */

// ---------- 假环境 ----------

interface TransitionFake {
  timers: TransitionTimers & { advance(ms: number): void; pendingCount(): number }
  events: TransitionEvents & { fireProbeTrigger(): void }
  probes: { count: number }
}

function makeFake(): TransitionFake {
  const pending = new Map<unknown, { cb: () => void; at: number }>()
  let now = 0
  let seq = 0
  let listener: (() => void) | null = null
  const probes = { count: 0 }

  return {
    timers: {
      setTimeout(cb, ms) {
        const handle = { id: ++seq }
        pending.set(handle, { cb, at: now + ms })
        return handle
      },
      clearTimeout(handle) {
        pending.delete(handle)
      },
      advance(ms) {
        const target = now + ms
        for (;;) {
          let earliestHandle: unknown = null
          let earliestAt = Number.POSITIVE_INFINITY
          for (const [handle, entry] of pending) {
            if (entry.at <= target && entry.at < earliestAt) {
              earliestHandle = handle
              earliestAt = entry.at
            }
          }
          if (earliestHandle === null) break
          const entry = pending.get(earliestHandle)!
          pending.delete(earliestHandle)
          now = entry.at
          entry.cb()
        }
        now = target
      },
      pendingCount() {
        return pending.size
      }
    },
    events: {
      addProbeTriggers(l) {
        listener = l
      },
      removeProbeTriggers() {
        listener = null
      },
      fireProbeTrigger() {
        listener?.()
      }
    },
    probes
  }
}

function sig(
  root: string | null,
  turnCount: number,
  firstTurnId: string | null,
  lastTurnId: string | null
): ConversationDomSignature {
  return { root: root as unknown as HTMLElement | null, turnCount, firstTurnId, lastTurnId }
}

// ---------- isConversationDomReady 判定 ----------

test('gate: 旧签名缺失（初始挂载）→ root 出现即 ready（含 0 turn 空对话）', () => {
  assert.equal(isConversationDomReady(null, sig('r1', 0, null, null)), true, '空对话不得等待 turnCount>0')
  assert.equal(isConversationDomReady(null, sig('r1', 5, 't1', 't5')), true)
  assert.equal(isConversationDomReady(null, sig(null, 0, null, null)), false, 'root 缺席绝不 ready')
})

test('gate: root 替换 → ready；旧 root 原样挂载 → 未 ready（B20 窗口语义）', () => {
  const previous = sig('root-a', 12, 'a-1', 'a-12')
  assert.equal(isConversationDomReady(previous, sig('root-b', 8, 'b-1', 'b-8')), true)
  assert.equal(isConversationDomReady(previous, sig('root-a', 12, 'a-1', 'a-12')), false)
})

test('gate: 同 root 原地换内容（React 复用）→ 首/尾 turn ID 变化即 ready', () => {
  const previous = sig('root-shared', 12, 'a-1', 'a-12')
  assert.equal(
    isConversationDomReady(previous, sig('root-shared', 8, 'b-1', 'b-8')),
    true,
    'root 复用 + turn 换代必须 ready（规格 #21）'
  )
  // 空对话原地清空：0 turn（首尾为 null）同样视为内容变化
  assert.equal(isConversationDomReady(previous, sig('root-shared', 0, null, null)), true)
})

test('gate: 旧签名无 root（原本无会话 DOM）→ 任何 root 出现即 ready', () => {
  const previous = sig(null, 0, null, null)
  assert.equal(isConversationDomReady(previous, sig('root-b', 0, null, null)), true)
})

// ---------- gate 行为 ----------

test('gate: 首探测（delay 0）即 ready → onReady 一次并停止（无残留计时）', () => {
  const fake = makeFake()
  let readyCount = 0
  let probeCount = 0

  beginConversationTransition({
    probe: () => {
      probeCount++
      return sig('root-b', 8, 'b-1', 'b-8')
    },
    isReady: (signature) => isConversationDomReady(sig('root-a', 12, 'a-1', 'a-12'), signature),
    onReady: () => readyCount++,
    timers: fake.timers,
    events: fake.events
  })

  assert.equal(readyCount, 1)
  assert.equal(probeCount, 1)
  assert.equal(fake.timers.pendingCount(), 0, 'ready 后绝不常驻（规格 #53）')
})

test('gate: DOM 延迟挂载 → 退避探测就绪（0/16ms 节奏，不等待 800ms 轮询）', () => {
  const fake = makeFake()
  let readyCount = 0
  let current = sig('root-a', 12, 'a-1', 'a-12') // t0：URL 已变，DOM 仍是旧会话

  beginConversationTransition({
    probe: () => {
      fake.probes.count++
      return current
    },
    isReady: (signature) => isConversationDomReady(sig('root-a', 12, 'a-1', 'a-12'), signature),
    onReady: () => readyCount++,
    timers: fake.timers,
    events: fake.events
  })

  assert.equal(readyCount, 0, 't0 旧 DOM 挂载期间绝不 ready')
  assert.equal(fake.probes.count, 1, '首探测同步执行（0ms 项）')

  fake.timers.advance(10)
  assert.equal(readyCount, 0)

  // t0+16ms：新会话 DOM 替换完成
  current = sig('root-b', 8, 'b-1', 'b-8')
  fake.timers.advance(10)
  assert.equal(readyCount, 1, '事件级延迟内就绪，无需等轮询')
  assert.equal(fake.probes.count, 2, '同步首探测 → 16ms 退避命中')
})

test('gate: 退避耗尽仍未就绪 → 停止轮询探测（不强把旧 DOM 当新 DOM），事件恢复补探测', () => {
  const fake = makeFake()
  let readyCount = 0
  let current = sig('root-a', 12, 'a-1', 'a-12')

  const gate = beginConversationTransition({
    probe: () => {
      fake.probes.count++
      return current
    },
    isReady: (signature) => isConversationDomReady(sig('root-a', 12, 'a-1', 'a-12'), signature),
    onReady: () => readyCount++,
    timers: fake.timers,
    events: fake.events
  })

  // 走完全部退避（0..800ms）：未就绪、无 onReady、计时清空
  fake.timers.advance(2000)
  assert.equal(readyCount, 0, '规格 #54：超时后保持 cache-only，绝不恢复旧 Store')
  assert.equal(fake.probes.count, TRANSITION_PROBE_DELAYS.length)
  assert.equal(fake.timers.pendingCount(), 0)
  assert.equal(gate.ready, false)

  // 事件恢复（focus / visibility）：补一次探测，仍未就绪则继续等待
  fake.events.fireProbeTrigger()
  assert.equal(fake.probes.count, TRANSITION_PROBE_DELAYS.length + 1)
  assert.equal(readyCount, 0)

  // DOM 最终就绪 → 事件恢复路径完成交付
  current = sig('root-b', 8, 'b-1', 'b-8')
  fake.events.fireProbeTrigger()
  assert.equal(readyCount, 1)
  assert.equal(gate.ready, true)
})

test('gate: probeNow（RootWatch 发现 root）→ 立即补一次探测', () => {
  const fake = makeFake()
  let readyCount = 0
  let current = sig(null, 0, null, null) // root 尚未出现

  const gate = beginConversationTransition({
    probe: () => {
      fake.probes.count++
      return current
    },
    isReady: (signature) => isConversationDomReady(null, signature),
    onReady: () => readyCount++,
    timers: fake.timers,
    events: fake.events
  })

  assert.equal(fake.probes.count, 1)
  current = sig('root-b', 8, 'b-1', 'b-8')
  gate.probeNow()
  assert.equal(readyCount, 1, 'root 生命周期信号立即触发就绪判定')
})

test('gate: stop() → 取消计时与事件监听，探测彻底失效', () => {
  const fake = makeFake()
  let readyCount = 0
  let current = sig('root-a', 12, 'a-1', 'a-12')

  const gate = beginConversationTransition({
    probe: () => {
      fake.probes.count++
      return current
    },
    isReady: (signature) => isConversationDomReady(sig('root-a', 12, 'a-1', 'a-12'), signature),
    onReady: () => readyCount++,
    timers: fake.timers,
    events: fake.events
  })

  assert.equal(fake.probes.count, 1)
  gate.stop()
  const probesAtStop = fake.probes.count

  current = sig('root-b', 8, 'b-1', 'b-8')
  fake.timers.advance(3000)
  fake.events.fireProbeTrigger()
  gate.probeNow()

  assert.equal(fake.probes.count, probesAtStop, 'stop 后零探测')
  assert.equal(readyCount, 0)
})

test('gate: 就绪后 probeNow / 事件 / 计时全部失效（onReady 恰好一次）', () => {
  const fake = makeFake()
  let readyCount = 0
  let current = sig(null, 0, null, null)

  const gate = beginConversationTransition({
    probe: () => {
      fake.probes.count++
      return current
    },
    isReady: (signature) => isConversationDomReady(null, signature),
    onReady: () => readyCount++,
    timers: fake.timers,
    events: fake.events
  })

  current = sig('root-b', 8, 'b-1', 'b-8')
  gate.probeNow()
  assert.equal(readyCount, 1)

  gate.probeNow()
  fake.events.fireProbeTrigger()
  fake.timers.advance(2000)

  assert.equal(readyCount, 1, 'onReady 绝不重复触发')
})

// ---------- readConversationDomSignature（廉价探测合同） ----------

test('gate: readConversationDomSignature 只读 root + turn roots（无正文解析）', () => {
  const el = (id: string) => {
    const node = { getAttribute: (name: string) => (name === 'data-turn-key' ? id : null) }
    return node as unknown as HTMLElement
  }
  const root = el('root')
  const provider = {
    getConversationRoot: () => root,
    locateTurnRoots: () => [
      { id: 't-1', root: el('t-1') },
      { id: 't-2', root: el('t-2') },
      { id: 't-3', root: el('t-3') }
    ]
  }

  const signature = readConversationDomSignature(provider)
  assert.equal(signature.root, root)
  assert.equal(signature.turnCount, 3)
  assert.equal(signature.firstTurnId, 't-1')
  assert.equal(signature.lastTurnId, 't-3')

  const empty = readConversationDomSignature({
    getConversationRoot: () => null,
    locateTurnRoots: () => []
  })
  assert.deepEqual(empty, { root: null, turnCount: 0, firstTurnId: null, lastTurnId: null })
})

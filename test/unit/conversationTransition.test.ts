import test from 'node:test'
import assert from 'node:assert/strict'
import {
  beginConversationTransition,
  createAcceptedDomState,
  createTransitionDomEvents,
  isConversationDomReady,
  readConversationDomSignature,
  TRANSITION_PROBE_DELAYS,
  TRANSITION_RECOVERY_POLL_MS,
  type ConversationDomSignature,
  type TransitionDomEvents,
  type TransitionEvents,
  type TransitionTimers
} from '../../src/content/conversationTransition.ts'

/**
 * Conversation Transition Gate 契约测试（规格 #16–#24 + eventual recovery）：
 * 旧/新 DOM 签名比较、短生命周期退避、fast 耗尽后 recovery poll / Mutation Wake、
 * give-up 后事件恢复、probeNow、ready/stop 后全部停止。全部注入假时钟与假事件，
 * 零真实等待。
 */

// ---------- 假环境 ----------

interface TransitionFake {
  timers: TransitionTimers & { advance(ms: number): void; pendingCount(): number }
  events: TransitionEvents & { fireProbeTrigger(): void }
  domEvents: TransitionDomEvents & { fireMutation(): void; subscribedCount(): number }
  probes: { count: number }
}

function makeFake(): TransitionFake {
  const pending = new Map<unknown, { cb: () => void; at: number }>()
  let now = 0
  let seq = 0
  let listener: (() => void) | null = null
  const domListeners = new Set<() => void>()
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
    domEvents: {
      subscribe(l) {
        domListeners.add(l)
      },
      unsubscribe(l) {
        domListeners.delete(l)
      },
      fireMutation() {
        for (const l of [...domListeners]) l()
      },
      subscribedCount() {
        return domListeners.size
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

test('gate: 退避耗尽仍未就绪 → 停止 fast 探测（不强把旧 DOM 当新 DOM），事件恢复补探测', () => {
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
    events: fake.events,
    domEvents: fake.domEvents
  })

  // 走完全部退避（0..800ms）：未就绪、无 onReady、fast 计时清空；
  // recovery poll 武装（不进入永久死等，规格 #15/#18）
  fake.timers.advance(2000)
  assert.equal(readyCount, 0, '规格 #54：超时后保持 cache-only，绝不恢复旧 Store')
  assert.equal(fake.probes.count, TRANSITION_PROBE_DELAYS.length)
  assert.equal(fake.timers.pendingCount(), 1, 'recovery poll 必须已武装（TR1）')
  assert.equal(gate.ready, false)
  assert.equal(gate.stats.mode, 'recovery-poll')

  // 事件恢复（focus / visibility）：补一次探测，仍未就绪则继续等待
  fake.events.fireProbeTrigger()
  assert.equal(fake.probes.count, TRANSITION_PROBE_DELAYS.length + 1)
  assert.equal(readyCount, 0)

  // DOM 最终就绪 → 事件恢复路径完成交付
  current = sig('root-b', 8, 'b-1', 'b-8')
  fake.events.fireProbeTrigger()
  assert.equal(readyCount, 1)
  assert.equal(gate.ready, true)
  assert.equal(fake.timers.pendingCount(), 0, 'ready 后 recovery 立即停止')
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

// ---------- TR1–TR5：fast 耗尽后的最终确定性恢复（规格 #15/#18） ----------

/** 构造一个始终不就绪的 gate（DOM 停留在旧会话 A） */
function beginStuckGate(
  fake: TransitionFake,
  current: { value: ConversationDomSignature },
  onReady: () => void = () => undefined
): ReturnType<typeof beginConversationTransition> {
  return beginConversationTransition({
    probe: () => {
      fake.probes.count++
      return current.value
    },
    isReady: (signature) =>
      isConversationDomReady(sig('root-a', 12, 'a-1', 'a-12'), signature),
    onReady,
    timers: fake.timers,
    events: fake.events,
    domEvents: fake.domEvents
  })
}

test('TR1: fast 退避全部耗尽仍未就绪 → recovery poll 武装（fast → slow，绝不 fast → dead）', () => {
  const fake = makeFake()
  const current = { value: sig('root-a', 12, 'a-1', 'a-12') }
  let readyCount = 0

  const gate = beginStuckGate(fake, current, () => readyCount++)

  // 退避表为相对间隔：0+16+50+100+200+400+800 ≈ 1.57s 后耗尽
  fake.timers.advance(1600)
  assert.equal(fake.probes.count, TRANSITION_PROBE_DELAYS.length, 'fast 探测恰好退避表次数')
  assert.equal(readyCount, 0)
  assert.equal(fake.timers.pendingCount(), 1, 'recovery timer 必须已武装')
  assert.equal(gate.stats.mode, 'recovery-poll')
  assert.equal(gate.stats.recoveryProbeCount, 0, 'recovery 尚未开火')

  // recovery 开火仍不就绪 → 继续武装，绝不停止
  fake.timers.advance(TRANSITION_RECOVERY_POLL_MS)
  assert.equal(fake.probes.count, TRANSITION_PROBE_DELAYS.length + 1)
  assert.equal(gate.stats.recoveryProbeCount, 1)
  assert.equal(fake.timers.pendingCount(), 1, '未就绪则 recovery 链式续期')

  fake.timers.advance(10_000)
  assert.equal(readyCount, 0, '旧 DOM 挂载期间绝不 ready')
  assert.equal(gate.stats.mode, 'recovery-poll', '长时间等待仍保持在 recovery 模式')
  assert.equal(
    gate.stats.probeCount,
    TRANSITION_PROBE_DELAYS.length + 1 + 6,
    '低频持续探测（10s 内再开火 6 次，1.5s 间隔链）'
  )
  assert.equal(gate.stats.recoveryProbeCount, 7)
})

test('TR2: recovery poll 探测到新会话 DOM → onReady 恰一次并停止全部探测', () => {
  const fake = makeFake()
  const current = { value: sig('root-a', 12, 'a-1', 'a-12') }
  let readyCount = 0

  const gate = beginStuckGate(fake, current, () => readyCount++)

  fake.timers.advance(1600) // fast 全部耗尽（~1.57s），未就绪
  assert.equal(readyCount, 0)

  // fast 窗口之后（late swap）DOM 才换成 B → recovery 下一跳完成交付
  current.value = sig('root-b', 8, 'b-1', 'b-8')
  fake.timers.advance(TRANSITION_RECOVERY_POLL_MS)

  assert.equal(readyCount, 1, 'recovery 路径完成交付')
  assert.equal(gate.stats.recoveryProbeCount, 1)
  assert.equal(gate.ready, true)
  assert.equal(fake.timers.pendingCount(), 0, 'ready 后零残留计时')
  assert.equal(gate.stats.mode, 'ready')

  const probesAtReady = fake.probes.count
  fake.timers.advance(10_000)
  fake.events.fireProbeTrigger()
  gate.probeNow()
  assert.equal(fake.probes.count, probesAtReady, 'ready 后零探测')
  assert.equal(readyCount, 1, 'onReady 绝不重复')
})

test('TR3: Mutation Wake —— fast 阶段内 DOM 变化立即唤醒探测并就绪', () => {
  const fake = makeFake()
  const current = { value: sig('root-a', 12, 'a-1', 'a-12') }
  let readyCount = 0

  const gate = beginStuckGate(fake, current, () => readyCount++)

  assert.equal(fake.domEvents.subscribedCount(), 1, 'begin 即订阅 Mutation Wake')
  fake.timers.advance(100)
  assert.equal(readyCount, 0)

  // same-root 原地换内容（RootWatch 无法感知的场景）→ mutation 立即唤醒
  current.value = sig('root-a', 8, 'b-1', 'b-8')
  fake.domEvents.fireMutation()

  assert.equal(readyCount, 1, 'mutation wake 路径完成交付')
  assert.equal(gate.stats.mutationWakeCount, 1)
  assert.equal(gate.stats.mode, 'ready')
  assert.equal(fake.domEvents.subscribedCount(), 0, 'ready 即退订（短生命周期）')
})

test('TR4: stop() → fast/recovery 计时与 Mutation Wake 订阅全部清除，之后零探测零回调', () => {
  const fake = makeFake()
  const current = { value: sig('root-a', 12, 'a-1', 'a-12') }
  let readyCount = 0

  const gate = beginStuckGate(fake, current, () => readyCount++)

  fake.timers.advance(1600) // fast 耗尽（~1.57s）→ recovery 武装
  assert.equal(fake.timers.pendingCount(), 1)
  gate.stop()

  assert.equal(fake.timers.pendingCount(), 0, 'recovery timer 已取消')
  assert.equal(fake.domEvents.subscribedCount(), 0, 'Mutation Wake 已退订')

  const probesAtStop = fake.probes.count
  current.value = sig('root-b', 8, 'b-1', 'b-8')
  fake.timers.advance(10_000)
  fake.domEvents.fireMutation()
  fake.events.fireProbeTrigger()
  gate.probeNow()

  assert.equal(fake.probes.count, probesAtStop, 'stop 后任何信号零探测')
  assert.equal(readyCount, 0)
})

test('TR5: 路由替换清理 —— A→B 未就绪即 B→C，B gate 的 recovery/wake 绝不触发', () => {
  const fake = makeFake()
  const current = { value: sig('root-a', 12, 'a-1', 'a-12') }
  let bReadyCount = 0
  let cReadyCount = 0

  const gateB = beginStuckGate(fake, current, () => bReadyCount++)
  fake.timers.advance(1600) // B 的 fast 耗尽 → recovery 武装

  // 模拟 B→C 路由替换：B gate stop，C gate 接管（同一假时钟/事件环境）
  gateB.stop()
  const gateC = beginStuckGate(fake, current, () => cReadyCount++)

  assert.equal(fake.timers.pendingCount(), 1, '只有 C 的当前调度在 pending（B 的已清除）')
  assert.equal(fake.domEvents.subscribedCount(), 1, '只有 C 订阅 Mutation Wake')

  const bProbes = gateB.stats.probeCount
  current.value = sig('root-c', 6, 'c-1', 'c-6')

  // B 的旧 recovery 周期与 mutation 信号：对 B 必须零效果
  fake.domEvents.fireMutation()
  assert.equal(bReadyCount, 0)
  assert.equal(gateB.stats.probeCount, bProbes, '停止的 B gate 零新探测')
  assert.equal(cReadyCount, 1, 'C gate 被 mutation wake 立即交付')
  assert.equal(gateC.ready, true)

  fake.timers.advance(10_000)
  assert.equal(bReadyCount, 0, 'B 的 recovery 链已断，绝不迟到交付')
  assert.equal(cReadyCount, 1)
})

// ---------- Mutation Wake 生产实现（合并语义 / 生命周期） ----------

test('wake: 生产 domEvents —— 多次 mutation 合并为一次回调（microtask 节流），退订即断开', async () => {
  const observed: Array<{ target: Node; options: unknown }> = []
  let disconnectCount = 0
  let mutationCallback: () => void = () => undefined
  const targetNode = {} as Node
  const domEvents = createTransitionDomEvents({
    target: () => targetNode,
    schedule: (cb) => queueMicrotask(cb),
    observerFactory: (cb) => {
      mutationCallback = cb
      return {
        observe(t, options) {
          observed.push({ target: t, options })
        },
        disconnect() {
          disconnectCount++
        }
      }
    }
  })

  let callCount = 0
  const listener = (): void => {
    callCount++
  }
  domEvents.subscribe(listener)

  assert.equal(observed.length, 1, 'subscribe 即观察')
  assert.equal(observed[0]!.target, targetNode)
  assert.deepEqual(observed[0]!.options, { childList: true, subtree: true })

  // 一次 swap 的 mutation 风暴：合并为一次回调
  mutationCallback()
  mutationCallback()
  mutationCallback()
  await Promise.resolve() // 让 queueMicrotask 的 flush 执行
  await Promise.resolve()
  assert.equal(callCount, 1, '一帧至多一次 probe 触发')

  // 新一批 mutation → 再次触发
  mutationCallback()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(callCount, 2)

  domEvents.unsubscribe(listener)
  assert.equal(disconnectCount, 1, 'unsubscribe 即 disconnect')
  mutationCallback()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(callCount, 2, '退订后 mutation 零回调')
})

// ---------- AS1：Accepted Live DOM Signature（previous 基线语义） ----------

test('AS1: accepted 快照 —— DOM 先于 route event 换代时，previous 必须仍是已接受的 A 签名', () => {
  const accepted = createAcceptedDomState()
  const sigA = sig('root-a', 12, 'a-1', 'a-12')
  accepted.record(sigA)
  assert.equal(accepted.present, true)

  // route event 到达前 DOM 已被换成 B（合法顺序 Order B）：
  // 临时读当前 DOM 会得到 previous == current → gate 永久等待（P0 根因 2）
  const wrongCurrentDom = sig('root-a', 24, 'b-1', 'b-24')
  assert.equal(
    accepted.snapshot(() => wrongCurrentDom),
    sigA,
    'previous 必须取已接受快照，绝不读 route-event 后的当前 DOM'
  )

  // route change 消费基线后失效：新会话 ready 前不存在 accepted
  accepted.invalidate()
  assert.equal(accepted.present, false)
  assert.equal(accepted.snapshot(() => wrongCurrentDom), wrongCurrentDom, '失效后回退 fallback')
  assert.equal(accepted.snapshot(null), null, '无 accepted 且无 fallback → null')
})

test('AS1b: same-root 原地换代 —— accepted 基线让 gate 正确判定 B 就绪且不误放 A', () => {
  const accepted = createAcceptedDomState()
  accepted.record(sig('root-shared', 12, 'a-1', 'a-12'))
  const previous = accepted.snapshot(null)

  assert.equal(
    isConversationDomReady(previous, sig('root-shared', 24, 'b-1', 'b-24')),
    true,
    '首/尾稳定 ID 变化 → B 就绪'
  )
  assert.equal(
    isConversationDomReady(previous, sig('root-shared', 12, 'a-1', 'a-12')),
    false,
    '仍是 A 的 DOM → 绝不 ready'
  )
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

import test from 'node:test'
import assert from 'node:assert/strict'
import { ConversationStore } from '../../src/conversation/store.ts'
import { ConversationIndexer } from '../../src/conversation/indexer.ts'
import { startStartupScan } from '../../src/content/startupScan.ts'
import type { ChatProvider, LocatedTurn } from '../../src/providers/types.ts'
import { liveTurn } from './helpers.ts'

/** 可追踪 parser 调用的 Provider 桩：full scan 走 locateTurns，增量走 locateTurnRoots + parseTurn */
function createTrackingProvider(initial: LocatedTurn[]): {
  provider: ChatProvider
  parseCalls: HTMLElement[]
  setTurns(next: LocatedTurn[]): void
} {
  let current = initial
  const parseCalls: HTMLElement[] = []
  const provider: ChatProvider = {
    name: 'tracking',
    locateTurns: () => current,
    locateTurnRoots: () => current.map((turn) => ({ id: turn.id, root: turn.root })),
    parseTurn: (turnRoot) => {
      parseCalls.push(turnRoot)
      return current.find((turn) => turn.root === turnRoot) ?? null
    },
    locateMessages: () => [],
    getConversationRoot: () => null,
    hasConversation: () => true,
    getTurnContainer: () => null,
    getConversationId: () => 'conv-1',
    isConversationRoute: () => true,
    getScrollContainer: () => null,
    invalidateDomCache: () => {},
    lastStrategyLabel: 'test',
    lastLocatedCount: current.length
  }
  return { provider, parseCalls, setTurns: (next) => (current = next) }
}

/** Spec #50/#61：新问题 → 只增量解析最新 turn，不重新 parse 已有 100 turns */
test('scanDirty: 新 turn 只 parse 新 root，顺序正确追加', () => {
  const a = liveTurn('A', 'A 的问题')
  const b = liveTurn('B', 'B 的问题')
  const c = liveTurn('C', 'C 的问题')
  const { provider, parseCalls, setTurns } = createTrackingProvider([a, b, c])
  const store = new ConversationStore()
  store.reset('conv-1')
  const indexer = new ConversationIndexer(provider, store)

  indexer.scan(true)
  assert.deepEqual(store.turns.map((turn) => turn.id), ['A', 'B', 'C'])
  assert.equal(parseCalls.length, 0) // full scan 走 locateTurns，不走 parseTurn

  parseCalls.length = 0
  const d = liveTurn('D', 'D 的问题')
  setTurns([a, b, c, d])
  indexer.scanDirty([d.root])

  assert.deepEqual(store.turns.map((turn) => turn.id), ['A', 'B', 'C', 'D'])
  assert.equal(parseCalls.length, 1) // 只解析 D
  assert.equal(parseCalls[0], d.root)
  assert.equal(store.turns[3]!.user!.element?.isConnected, true)
  assert.deepEqual(store.turns.map((turn) => turn.index), [0, 1, 2, 3])
})

/** Spec #48/#49/#64：removed turn root → metadata 保留、元素解绑，绝不删除 turn */
test('scanDirty: 卸载的 turn 保留 metadata 并解除元素绑定', () => {
  const a = liveTurn('A', 'A 的问题')
  const b = liveTurn('B', 'B 的问题')
  const c = liveTurn('C', 'C 的问题')
  const { provider, parseCalls, setTurns } = createTrackingProvider([a, b, c])
  const store = new ConversationStore()
  store.reset('conv-1')
  const indexer = new ConversationIndexer(provider, store)
  indexer.scan(true)

  parseCalls.length = 0
  setTurns([a, b]) // C 的 root 已被虚拟化卸载（不再出现在 DOM）
  indexer.scanDirty([c.root])

  assert.deepEqual(store.turns.map((turn) => turn.id), ['A', 'B', 'C'])
  const kept = store.getTurn('C')
  assert.ok(kept !== undefined) // metadata 保留
  assert.equal(kept!.user!.element, undefined)
  assert.equal(kept!.user!.isMounted, false)
  assert.equal(parseCalls.length, 0) // A/B 零查询跳过
})

/** Spec #82/#95：增量无法安全处理 → 回退 full scan（legacy 无原生 id） */
test('scanDirty: 无原生 id 时回退 full scan，结果仍正确', () => {
  const a = liveTurn('A', 'A 的问题')
  const { provider, setTurns } = createTrackingProvider([a])
  // 覆盖 locateTurnRoots 返回 null id（legacy DOM）
  const legacy: ChatProvider = {
    ...provider,
    locateTurnRoots: () => [{ id: null, root: a.root }]
  }
  const store = new ConversationStore()
  store.reset('conv-1')
  const indexer = new ConversationIndexer(legacy, store)
  indexer.scan(true)

  const b = liveTurn('B', 'B 的问题')
  setTurns([a, b])
  indexer.scanDirty([b.root])

  assert.deepEqual(store.turns.map((turn) => turn.id), ['A', 'B']) // full scan 兜底结果正确
})

/** Spec #30/#31/#69：连续 2 次签名不变 → 提前停止启动重试（3 次扫描后稳定） */
test('startupScan: 稳定后停止重试', async () => {
  let scans = 0
  let settled = false
  const stop = startStartupScan({
    scan: () => {
      scans++
      return { turnCount: 10, lastTurnId: 'J10' }
    },
    hasRoot: () => true,
    delays: [2, 2, 2, 2, 2, 2],
    onSettled: () => {
      settled = true
    }
  })
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(scans, 3)
  assert.equal(settled, true)
  stop()
})

/** 签名持续变化 → 走满全部退避间隔后停止（不做无限轮询） */
test('startupScan: 不稳定时按退避表走满即停', async () => {
  let scans = 0
  const stop = startStartupScan({
    scan: () => {
      scans++
      return { turnCount: scans, lastTurnId: `T${scans}` }
    },
    hasRoot: () => true,
    delays: [2, 2, 2, 2, 2, 2]
  })
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(scans, 6) // 每个退避间隔各扫一次，走满即停
  stop()
})

/** root 尚未出现 → 不计稳定，继续等待（规格 #30） */
/** root 缺失 → 不计稳定：恒定签名也必须走满退避表（若误判稳定 3 次即停） */
test('startupScan: root 缺失时不提前停止', async () => {
  let scans = 0
  const stop = startStartupScan({
    scan: () => {
      scans++
      return { turnCount: 10, lastTurnId: 'J10' }
    },
    hasRoot: () => false,
    delays: [2, 2, 2, 2, 2, 2]
  })
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(scans, 6)
  stop()
})


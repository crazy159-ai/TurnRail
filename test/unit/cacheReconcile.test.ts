import test from 'node:test'
import assert from 'node:assert/strict'
import { ConversationStore } from '../../src/conversation/store.ts'
import { ConversationIndexer } from '../../src/conversation/indexer.ts'
import { hydrateCachedConversation } from '../../src/cache/hydrator.ts'
import { isLikelyStale } from '../../src/cache/reconciler.ts'
import { fakeProvider, liveTurn, makeCached } from './helpers.ts'

/**
 * Spec #53 Test 6：reconcile —— 缓存 A B C D + Live C D → 最终 A B C D，
 * 且 C/D 拥有 live elements（Live 胜出），A/B 保持未挂载。
 */
test('reconcile: cache A B C D + live C D → A B C D（C/D 绑定 live）', () => {
  const store = new ConversationStore()
  store.reset('conv-1')
  hydrateCachedConversation(store, makeCached('conv-1', ['A', 'B', 'C', 'D']))

  const indexer = new ConversationIndexer(fakeProvider([liveTurn('C', 'C 的问题'), liveTurn('D', 'D 的问题')]), store)
  indexer.scan(true)

  assert.deepEqual(store.turns.map((turn) => turn.id), ['A', 'B', 'C', 'D'])
  assert.equal(store.turns[2]!.user!.element?.isConnected, true)
  assert.equal(store.turns[3]!.user!.element?.isConnected, true)
  // Live 数据胜出：挂载后标题由 Live 正文重建
  assert.equal(store.turns[2]!.title, 'C 的问题')
  // 未挂载的缓存 turn 保留（缓存价值所在），element 仍为空
  assert.equal(store.turns[0]!.user!.element, undefined)
  assert.equal(store.turns[1]!.user!.element, undefined)
})

/** Spec #53 Test 7：new turn —— 缓存 A B C + Live B C D → A B C D */
test('reconcile: cache A B C + live B C D → A B C D', () => {
  const store = new ConversationStore()
  store.reset('conv-1')
  hydrateCachedConversation(store, makeCached('conv-1', ['A', 'B', 'C']))

  const indexer = new ConversationIndexer(
    fakeProvider([liveTurn('B', 'B 的问题'), liveTurn('C', 'C 的问题'), liveTurn('D', 'D 的问题')]),
    store
  )
  indexer.scan(true)

  assert.deepEqual(store.turns.map((turn) => turn.id), ['A', 'B', 'C', 'D'])
  assert.equal(store.turns[3]!.user!.element?.isConnected, true)
  assert.equal(store.turns[0]!.user!.element, undefined)
  // index 连续重排
  assert.deepEqual(store.turns.map((turn) => turn.index), [0, 1, 2, 3])
})

/** Spec #53 Test 8：cache hit —— DOM 扫描完成前 Store 已能输出 cached turns */
test('cache hit: 未扫描 DOM 前 Store 已有完整缓存目录', () => {
  const store = new ConversationStore()
  store.reset('conv-1')
  // 不创建任何 provider / 不调用 scan —— 模拟 ChatGPT 历史尚未挂载
  const hydrated = hydrateCachedConversation(store, makeCached('conv-1', ['A', 'B', 'C']))

  assert.equal(hydrated, 3)
  assert.equal(store.turns.length, 3)
  assert.equal(store.cacheHydrated, true)
  // 目录可直接渲染：id / index / title / preview 齐备
  assert.deepEqual(store.turns.map((turn) => turn.index), [0, 1, 2])
  assert.ok(store.turns.every((turn) => turn.title.length > 0))
})

/**
 * Spec #53 Test 9：route race —— A 的缓存请求 resolve 时已切到 B，
 * A 缓存不得写入 B Store（hydrate 层 conversationKey 守卫）。
 */
test('route race: A 缓存不能 hydrate 进 B 会话', () => {
  const storeB = new ConversationStore()
  storeB.reset('conv-B')
  const cachedA = makeCached('conv-A', ['A1', 'A2', 'A3'])

  const hydrated = hydrateCachedConversation(storeB, cachedA)

  assert.equal(hydrated, 0)
  assert.equal(storeB.turns.length, 0)
  assert.equal(storeB.cacheHydrated, false)
})

/** Spec #35：stale 判定 —— Live ≥3 且与缓存零重叠 → stale；有重叠/数量不足 → 非 stale */
test('isLikelyStale: 零重叠且 live≥3 判定 stale', () => {
  const cachedIds = new Set(['A', 'B', 'C'])
  assert.equal(isLikelyStale(cachedIds, ['X', 'Y', 'Z']), true)
  assert.equal(isLikelyStale(cachedIds, ['X', 'Y']), false)
  assert.equal(isLikelyStale(cachedIds, ['B', 'Y', 'Z']), false)
  assert.equal(isLikelyStale(new Set(), ['X', 'Y', 'Z']), false)
})

/** Spec #34：stale 后 dropTurns 只清未挂载缓存 turn，Live turn 与挂载缓存 turn 保留 */
test('stale drop: 未挂载缓存 turn 被清理，live 保留', () => {
  const store = new ConversationStore()
  store.reset('conv-1')
  hydrateCachedConversation(store, makeCached('conv-1', ['A', 'B', 'C']))
  const indexer = new ConversationIndexer(
    fakeProvider([liveTurn('X', 'X 的问题'), liveTurn('Y', 'Y 的问题'), liveTurn('Z', 'Z 的问题')]),
    store
  )
  indexer.scan(true)
  // 此时 stale：缓存 A/B/C 全部未挂载、Live X/Y/Z ≥3 零重叠
  const dropIds = new Set(
    store.turns.filter((turn) => ['A', 'B', 'C'].includes(turn.id) && !turn.user?.element?.isConnected).map((turn) => turn.id)
  )
  store.dropTurns(dropIds)

  assert.deepEqual(store.turns.map((turn) => turn.id), ['X', 'Y', 'Z'])
  assert.deepEqual(store.turns.map((turn) => turn.index), [0, 1, 2])
})

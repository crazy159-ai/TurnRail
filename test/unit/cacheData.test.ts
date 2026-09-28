import test from 'node:test'
import assert from 'node:assert/strict'
import { ConversationStore } from '../../src/conversation/store.ts'
import { serializeConversation } from '../../src/cache/serializer.ts'
import { parseCachedConversation } from '../../src/cache/validate.ts'
import { hydrateCachedConversation } from '../../src/cache/hydrator.ts'
import { makeCached, makeTurn } from './helpers.ts'

/** Spec #53 Test 1：serialize —— Runtime Store 3 turns → 3 CachedTurns，无 HTMLElement / 正文全文 */
test('serialize: user turns → CachedTurns，JSON 纯净', () => {
  const store = new ConversationStore()
  store.reset('conv-1')
  store.turns = [
    makeTurn('A', 0, '第一个问题的完整正文'.repeat(5)),
    makeTurn('B', 1, '第二个问题'),
    makeTurn('C', 2, '第三个问题')
  ]

  const snapshot = serializeConversation(store, {
    provider: 'chatgpt',
    conversationId: 'conv-1',
    complete: false,
    pinned: true
  })

  assert.equal(snapshot.schemaVersion, 1)
  assert.equal(snapshot.provider, 'chatgpt')
  assert.equal(snapshot.conversationId, 'conv-1')
  assert.equal(snapshot.turnCount, 3)
  assert.deepEqual(snapshot.turns.map((turn) => turn.id), ['A', 'B', 'C'])
  assert.deepEqual(snapshot.turns.map((turn) => turn.index), [0, 1, 2])
  for (const turn of snapshot.turns) {
    // 导航元数据字段白名单：绝无 element / 正文全文 / DOM 引用
    assert.deepEqual(Object.keys(turn).sort(), ['id', 'index', 'preview', 'title', 'userMessageId'])
    assert.ok(turn.title.length <= 80)
    assert.ok((turn.preview ?? '').length <= 200)
  }
  // 可安全 JSON 序列化（无 HTMLElement / Map / 循环引用）
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot)
})

/** Spec #53 Test 2：合法 schemaVersion 1 缓存加载成功 */
test('validate: 合法缓存解析成功', () => {
  const cached = makeCached('conv-1', ['A', 'B'])
  const parsed = parseCachedConversation(JSON.parse(JSON.stringify(cached)))
  assert.ok(parsed !== null)
  assert.equal(parsed!.conversationId, 'conv-1')
  assert.equal(parsed!.turnCount, 2)
  assert.equal(parsed!.turns[1]!.id, 'B')
})

/** Spec #53 Test 3：malformed cache → null / ignored，不 crash */
test('validate: 损坏缓存返回 null', () => {
  assert.equal(parseCachedConversation({ schemaVersion: 1, turns: 'broken' }), null)
  assert.equal(parseCachedConversation(null), null)
  assert.equal(parseCachedConversation('junk'), null)
  assert.equal(parseCachedConversation({ schemaVersion: 1, provider: 'chatgpt' }), null)
  const brokenTurn = makeCached('conv-1', ['A'])
  ;(brokenTurn.turns[0] as unknown as Record<string, unknown>).index = 'zero'
  assert.equal(parseCachedConversation(brokenTurn), null)
})

/** Spec #53 Test 4：future schema → 忽略，走 live rebuild */
test('validate: 未来 schema 版本被忽略', () => {
  const future = makeCached('conv-1', ['A']) as unknown as Record<string, unknown>
  future.schemaVersion = 999
  assert.equal(parseCachedConversation(future), null)
})

/** Spec #53 Test 5：hydrate —— A/B/C 恢复，element 全部为空（只能来自 Live DOM） */
test('hydrate: 恢复 id/顺序/标题，element 为空', () => {
  const store = new ConversationStore()
  store.reset('conv-1')
  const cached = makeCached('conv-1', ['A', 'B', 'C'])

  const hydrated = hydrateCachedConversation(store, cached)

  assert.equal(hydrated, 3)
  assert.equal(store.turns.length, 3)
  assert.deepEqual(store.turns.map((turn) => turn.id), ['A', 'B', 'C'])
  assert.equal(store.cacheHydrated, true)
  for (const turn of store.turns) {
    assert.ok(turn.user)
    assert.equal(turn.user!.element, undefined)
    assert.equal(turn.root, undefined)
    assert.equal(turn.assistant, undefined)
    assert.equal(turn.title, `问题 ${turn.id}`)
  }
  // user 消息 metadata 恢复（text 用 preview 截断文本，不是完整 prompt）
  assert.equal(store.turns[0]!.user!.text, 'A 的提问内容预览')
})

/** Store.dropTurns：stale 清理后 index 连续、detached 同步清理 */
test('store.dropTurns: 移除并重排 index', () => {
  const store = new ConversationStore()
  store.reset('conv-1')
  store.turns = [makeTurn('A', 0, 'a'), makeTurn('B', 1, 'b'), makeTurn('C', 2, 'c')]

  store.dropTurns(new Set(['B']))

  assert.deepEqual(store.turns.map((turn) => turn.id), ['A', 'C'])
  assert.deepEqual(store.turns.map((turn) => turn.index), [0, 1])
})

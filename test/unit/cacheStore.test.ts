import test from 'node:test'
import assert from 'node:assert/strict'
import { ConversationCacheStore } from '../../src/cache/cacheStore.ts'
import { conversationCacheKey } from '../../src/cache/types.ts'
import { serializeConversation } from '../../src/cache/serializer.ts'
import { hydrateCachedConversation } from '../../src/cache/hydrator.ts'
import { ConversationStore } from '../../src/conversation/store.ts'
import { ConversationIndexer } from '../../src/conversation/indexer.ts'
import { fakeProvider, liveTurn, makeCached, makeStorage } from './helpers.ts'

/** CacheStore put/get 往返：写入的 DTO 原样读回 */
test('cacheStore: put → get 往返一致', async () => {
  const store = new ConversationCacheStore(makeStorage())
  assert.equal(store.isAvailable(), true)

  const snapshot = {
    schemaVersion: 1 as const,
    provider: 'chatgpt',
    conversationId: 'conv-1',
    createdAt: 1000,
    updatedAt: 2000,
    lastAccessAt: 2000,
    turnCount: 2,
    complete: false,
    pinned: true,
    turns: [
      { id: 'A', index: 0, userMessageId: 'A', title: '问题 A', preview: 'A 预览' },
      { id: 'B', index: 1, userMessageId: 'B', title: '问题 B' }
    ]
  }
  await store.put(snapshot)

  const loaded = await store.get('chatgpt', 'conv-1')
  assert.ok(loaded !== null)
  assert.equal(loaded!.conversationId, 'conv-1')
  assert.equal(loaded!.turnCount, 2)
  assert.equal(loaded!.turns[1]!.preview, undefined)
  assert.equal(loaded!.complete, false)
  assert.equal(loaded!.pinned, true)
})

/** 索引：put 后 list() 有条目，remove 后消失；未缓存会话 get → null（hit=false） */
test('cacheStore: 索引 list / remove / 未命中', async () => {
  const storage = makeStorage()
  const store = new ConversationCacheStore(storage)
  const snapshot = {
    schemaVersion: 1 as const,
    provider: 'chatgpt',
    conversationId: 'conv-1',
    createdAt: 1,
    updatedAt: 2,
    lastAccessAt: 2,
    turnCount: 1,
    complete: false,
    pinned: true,
    turns: [{ id: 'A', index: 0, title: '问题 A' }]
  }
  await store.put(snapshot)

  const entries = await store.list()
  assert.equal(entries.length, 1)
  assert.equal(entries[0]!.conversationId, 'conv-1')
  assert.equal(entries[0]!.turnCount, 1)

  const miss = await store.get('chatgpt', 'conv-404')
  assert.equal(miss, null)
  assert.equal(store.getStats().hit, false)

  await store.remove('chatgpt', 'conv-1')
  assert.equal(await store.get('chatgpt', 'conv-1'), null)
  assert.equal((await store.list()).length, 0)
  assert.equal(conversationCacheKey('chatgpt', 'conv-1') in storage.dump(), false)
})

/** touch 更新 lastAccessAt；setPinned 切换 pinned；clear 清空全部 */
test('cacheStore: touch / setPinned / clear', async () => {
  const store = new ConversationCacheStore(makeStorage())
  const snapshot = {
    schemaVersion: 1 as const,
    provider: 'chatgpt',
    conversationId: 'conv-1',
    createdAt: 1,
    updatedAt: 2,
    lastAccessAt: 2,
    turnCount: 1,
    complete: false,
    pinned: true,
    turns: [{ id: 'A', index: 0, title: '问题 A' }]
  }
  await store.put(snapshot)

  await store.touch('chatgpt', 'conv-1')
  const touched = await store.get('chatgpt', 'conv-1')
  assert.ok(touched!.lastAccessAt >= 2)

  await store.setPinned('chatgpt', 'conv-1', false)
  assert.equal((await store.get('chatgpt', 'conv-1'))!.pinned, false)

  await store.clear()
  assert.equal(await store.get('chatgpt', 'conv-1'), null)
  assert.equal((await store.list()).length, 0)
})

/**
 * v1.2.2 Test A：预期生命周期异常（Extension context invalidated）
 * 必须安静降级 —— 生产（DEBUG=false）不得产生任何 console.warn，
 * 并记录 unavailableReason = 'extension-context-invalidated'。
 */
test('storage failure: extension context invalidated → 静默降级 + 记录原因', async () => {
  const invalidated = new Error('Extension context invalidated.')
  const throwing = {
    get: () => Promise.reject(invalidated),
    set: () => Promise.reject(invalidated),
    remove: () => Promise.reject(invalidated)
  }
  const cacheStore = new ConversationCacheStore(throwing)
  assert.equal(cacheStore.isAvailable(), true)

  const originalWarn = console.warn
  let warnings = 0
  console.warn = () => {
    warnings++
  }
  try {
    // 测试环境 DEBUG=false：预期生命周期异常必须完全安静
    assert.equal(await cacheStore.get('chatgpt', 'conv-1'), null)
    assert.equal(cacheStore.isAvailable(), false)
    assert.equal(cacheStore.getStats().available, false)
    assert.equal(cacheStore.getUnavailableReason(), 'extension-context-invalidated')
    assert.equal(warnings, 0)

    // 不可用后所有 mutating API 直接 false（true == storage 操作真实成功）
    assert.equal(await cacheStore.put(makeCached('conv-1', ['A'])), false)
    assert.equal(await cacheStore.remove('chatgpt', 'conv-1'), false)
    assert.equal(await cacheStore.touch('chatgpt', 'conv-1'), false)
    assert.equal(await cacheStore.setPinned('chatgpt', 'conv-1', true), false)
    assert.equal(await cacheStore.clear(), false)
    assert.equal(warnings, 0)
  } finally {
    console.warn = originalWarn
  }
})

/**
 * v1.2.2 Test B：未知 storage 故障仍必须走 reportError —— 热修复没有把真实错误吞掉。
 */
test('storage failure: 未知 storage 错误 → 仍 reportError + 原因 storage-error', async () => {
  const boom = new Error('storage backend exploded')
  const throwing = {
    get: () => Promise.reject(boom),
    set: () => Promise.reject(boom),
    remove: () => Promise.reject(boom)
  }
  const cacheStore = new ConversationCacheStore(throwing)

  const originalWarn = console.warn
  let warnings = 0
  console.warn = () => {
    warnings++
  }
  try {
    assert.equal(await cacheStore.get('chatgpt', 'conv-1'), null)
    assert.equal(cacheStore.isAvailable(), false)
    assert.equal(cacheStore.getUnavailableReason(), 'storage-error')
    assert.ok(warnings > 0)
  } finally {
    console.warn = originalWarn
  }
})

/** v1.2.2 Test C：mutating API 成功必须返回 true（true == storage 操作真实完成） */
test('cacheStore: mutating API 成功返回 true', async () => {
  const store = new ConversationCacheStore(makeStorage())
  assert.equal(await store.put(makeCached('conv-1', ['A'])), true)
  assert.equal(await store.touch('chatgpt', 'conv-1'), true)
  assert.equal(await store.setPinned('chatgpt', 'conv-1', false), true)
  assert.equal(await store.remove('chatgpt', 'conv-1'), true)
  assert.equal(await store.clear(), true)
})

/** v1.2.2 Test D：mutating API 失败必须返回 false（UI 假成功的根源在这里被切断） */
test('cacheStore: mutating API 失败返回 false', async () => {
  const boom = new Error('disk io error')
  const throwing = {
    get: () => Promise.reject(boom),
    set: () => Promise.reject(boom),
    remove: () => Promise.reject(boom)
  }
  const store = new ConversationCacheStore(throwing)

  const originalWarn = console.warn
  console.warn = () => {}
  try {
    assert.equal(await store.put(makeCached('conv-1', ['A'])), false)
    assert.equal(store.isAvailable(), false)
    assert.equal(store.getUnavailableReason(), 'storage-error')
  } finally {
    console.warn = originalWarn
  }
})

/** Live 模式回归合同：缓存层失败后 Store + Indexer 完全不受影响 */
test('storage failure: 静默降级到 Live-only（Live 模式不受影响）', async () => {
  const boom = new Error('storage unavailable')
  const throwing = {
    get: () => Promise.reject(boom),
    set: () => Promise.reject(boom),
    remove: () => Promise.reject(boom)
  }
  const cacheStore = new ConversationCacheStore(throwing)
  assert.equal(cacheStore.isAvailable(), true)
  assert.equal(await cacheStore.get('chatgpt', 'conv-1'), null)
  assert.equal(cacheStore.isAvailable(), false)

  // Live 模式不受影响：Store + Indexer 照常工作
  const store = new ConversationStore()
  store.reset('conv-1')
  const indexer = new ConversationIndexer(fakeProvider([liveTurn('A', 'A 的问题')]), store)
  indexer.scan(true)
  assert.equal(store.turns.length, 1)
  assert.equal(store.turns[0]!.id, 'A')
})

/** storage 缺失环境（无 chrome.storage）→ 构造即不可用（missing-api），一切 no-op */
test('cacheStore: 无 storage 时 Live-only', async () => {
  const store = new ConversationCacheStore(null)
  assert.equal(store.isAvailable(), false)
  assert.equal(store.getUnavailableReason(), 'missing-api')
  assert.equal(await store.get('chatgpt', 'conv-1'), null)
  assert.equal(await store.put(makeCached('conv-1', ['A'])), false)
  assert.equal(await store.remove('chatgpt', 'conv-1'), false)
  assert.equal(await store.touch('chatgpt', 'conv-1'), false)
  assert.equal(await store.setPinned('chatgpt', 'conv-1', true), false)
  assert.equal(await store.clear(), false)
  assert.equal((await store.list()).length, 0)
})

/** 端到端：Live 扫描出的 Store → serialize → put → get → parse → hydrate 往返 */
test('round trip: live store → cache → hydrate', async () => {
  const storage = makeStorage()
  const cacheStore = new ConversationCacheStore(storage)

  const store = new ConversationStore()
  store.reset('conv-rt')
  const indexer = new ConversationIndexer(
    fakeProvider([liveTurn('Q1', '第一个问题？'), liveTurn('Q2', '第二个问题？')]),
    store
  )
  indexer.scan(true)

  const snapshot = serializeConversation(store, {
    provider: 'chatgpt',
    conversationId: 'conv-rt',
    complete: false,
    pinned: true
  })
  await cacheStore.put(snapshot)

  const raw = storage.dump()[conversationCacheKey('chatgpt', 'conv-rt')]
  const parsed = await cacheStore.get('chatgpt', 'conv-rt')
  assert.ok(parsed !== null)

  const store2 = new ConversationStore()
  store2.reset('conv-rt')
  const hydrated = hydrateCachedConversation(store2, parsed!)
  assert.equal(hydrated, 2)
  assert.deepEqual(store2.turns.map((turn) => turn.id), ['Q1', 'Q2'])
  assert.equal(store2.turns[0]!.user!.element, undefined)
  assert.ok(typeof raw === 'object')
})

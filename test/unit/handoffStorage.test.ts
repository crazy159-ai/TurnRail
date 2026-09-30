import test from 'node:test'
import assert from 'node:assert/strict'
import { PendingHandoffStore } from '../../src/handoff/pendingStore.ts'
import { injectPendingHandoff } from '../../src/handoff/injector.ts'
import { PENDING_HANDOFF_KEY, PENDING_HANDOFF_TTL_MS } from '../../src/handoff/types.ts'
import type { ConversationContinuationCapability } from '../../src/providers/types.ts'
import { makeStorage } from './helpers.ts'

/**
 * PendingHandoff 存储与注入测试矩阵（规格 #35 Test 15-20）：
 * 创建 / 消费即删 / TTL 过期不注入 / storage 失败无假成功 /
 * context invalidated 回退 / 无 pending 时新页面零行为。
 */

const PAYLOAD = '# TurnRail Context Handoff\n\n## Current Objective\n继续任务。'

/** 拒绝一切写入 / 读取的 storage（模拟故障与 extension context invalidated） */
const rejectingStorage = {
  get: () => Promise.reject(new Error('Extension context invalidated.')),
  set: () => Promise.reject(new Error('Extension context invalidated.')),
  remove: () => Promise.reject(new Error('Extension context invalidated.'))
}

/** capability spy：记录每次调用，getComposer 可配置 */
function fakeCapability(options: { composer: HTMLElement | null } = { composer: null }) {
  const calls = { getComposer: 0, setComposerText: 0, openNewConversation: 0 }
  let lastText: string | null = null
  const capability: ConversationContinuationCapability = {
    getComposer: () => {
      calls.getComposer++
      return options.composer
    },
    setComposerText: (text: string) => {
      calls.setComposerText++
      lastText = text
      return true
    },
    openNewConversation: () => {
      calls.openNewConversation++
    }
  }
  return { capability, calls, getLastText: () => lastText }
}

// ---------- Test 15：create pending ----------

test('pending: save → peek 读回 payload，TTL = now + PENDING_HANDOFF_TTL_MS', async () => {
  const storage = {
    get: async (key: string) => ({ [key]: data.get(key) }),
    set: async (items: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(items)) data.set(k, v)
    },
    remove: async (key: string) => {
      data.delete(key)
    }
  }
  const data = new Map<string, unknown>()
  const store = new PendingHandoffStore(storage)

  const before = Date.now()
  assert.equal(await store.save(PAYLOAD), true)
  const pending = await store.peek()
  assert.ok(pending !== null)
  assert.equal(pending!.payload, PAYLOAD)
  assert.equal(pending!.schemaVersion, 1)
  assert.equal(pending!.sourceProvider, 'chatgpt')
  assert.ok(pending!.expiresAt - pending!.createdAt <= PENDING_HANDOFF_TTL_MS)
  assert.ok(pending!.expiresAt - pending!.createdAt >= PENDING_HANDOFF_TTL_MS - 10)
  assert.ok(pending!.createdAt >= before)
  // 独立命名空间：写在 turnrail:handoff:pending，绝不触碰 cache index
  assert.ok(data.has(PENDING_HANDOFF_KEY))
  assert.equal(data.has('turnrail:cache:index'), false)
})

test('pending: 同一时刻至多一个 pending —— 再次 save 覆盖旧记录', async () => {
  const store = new PendingHandoffStore(makeStorage())
  assert.equal(await store.save('第一份'), true)
  assert.equal(await store.save('第二份'), true)
  const pending = await store.peek()
  assert.equal(pending!.payload, '第二份')
})

// ---------- Test 16：consume 后立即删除 ----------

test('pending: consume 返回记录并立即删除，二次 peek 为 null', async () => {
  const store = new PendingHandoffStore(makeStorage())
  await store.save(PAYLOAD)
  const consumed = await store.consume()
  assert.equal(consumed!.payload, PAYLOAD)
  assert.equal(await store.peek(), null)
  assert.equal(await store.consume(), null)
})

// ---------- Test 17：过 TTL 不注入 ----------

test('pending: 过期记录 peek 即删即作废，注入器返回 no-pending', async () => {
  const data = new Map<string, unknown>()
  const storage = {
    get: async (key: string) => ({ [key]: data.get(key) }),
    set: async (items: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(items)) data.set(k, v)
    },
    remove: async (key: string) => {
      data.delete(key)
    }
  }
  const now = Date.now()
  data.set(PENDING_HANDOFF_KEY, {
    schemaVersion: 1,
    id: 'expired',
    createdAt: now - PENDING_HANDOFF_TTL_MS * 2,
    expiresAt: now - PENDING_HANDOFF_TTL_MS, // 已过期
    sourceProvider: 'chatgpt',
    payload: PAYLOAD
  })
  const store = new PendingHandoffStore(storage)
  const { capability, calls } = fakeCapability({ composer: null })

  assert.equal(await store.peek(), null)
  assert.equal(data.has(PENDING_HANDOFF_KEY), false, '过期记录必须被删除')
  assert.equal(await injectPendingHandoff(capability, store), 'no-pending')
  assert.equal(calls.getComposer, 0, '无有效 pending 时不得触碰 composer')
})

// ---------- Test 18：storage failure 不产生假成功 ----------

test('pending: storage 写失败 → save false（不抛错）；读失败 → peek null', async () => {
  const store = new PendingHandoffStore(rejectingStorage)
  // storage 存在但故障（含 context invalidated）：isAvailable 只反映"有 storage"，
  // 故障必须表现为 save false / peek null，而不是可用性状态谎报
  assert.equal(store.isAvailable(), true)
  assert.equal(await store.save(PAYLOAD), false, '写失败必须返回 false，绝不假成功')
  assert.equal(await store.peek(), null)
  assert.equal(await store.consume(), null)
  // 空载荷同样拒绝
  const okStore = new PendingHandoffStore(makeStorage())
  assert.equal(await okStore.save(''), false)
})

test('pending: 损坏记录（schema / 字段缺失）按无 pending 处理', async () => {
  const data = new Map<string, unknown>()
  const storage = {
    get: async (key: string) => ({ [key]: data.get(key) }),
    set: async (items: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(items)) data.set(k, v)
    },
    remove: async (key: string) => {
      data.delete(key)
    }
  }
  const store = new PendingHandoffStore(storage)
  data.set(PENDING_HANDOFF_KEY, { payload: '没有 schema 的记录' })
  assert.equal(await store.peek(), null)
  data.set(PENDING_HANDOFF_KEY, { schemaVersion: 2, payload: '未来版本', id: 'x', createdAt: 1, expiresAt: 2, sourceProvider: 'chatgpt' })
  assert.equal(await store.peek(), null)
})

// ---------- Test 19：context invalidated → fallback 契约 ----------

test('pending: context invalidated 下 save false，注入器 no-pending，不抛未捕获异常', async () => {
  const store = new PendingHandoffStore(rejectingStorage)
  const { capability, calls } = fakeCapability({ composer: null })
  // bootstrap 的回退契约：save false → 走剪贴板提示（此处验证存储层如实失败）
  assert.equal(await store.save(PAYLOAD), false)
  assert.equal(await injectPendingHandoff(capability, store), 'no-pending')
  assert.equal(calls.getComposer, 0)
})

test('pending: composer 写入失败 → failed 且 pending 保留（TTL 兜底）', async () => {
  const store = new PendingHandoffStore(makeStorage())
  await store.save(PAYLOAD)
  let setCalls = 0
  const capability: ConversationContinuationCapability = {
    getComposer: () => ({ isConnected: true }) as unknown as HTMLElement,
    setComposerText: () => {
      setCalls++
      return false
    },
    openNewConversation: () => undefined
  }
  assert.equal(await injectPendingHandoff(capability, store, { composerWaitMs: 200, pollIntervalMs: 50 }), 'failed')
  assert.equal(setCalls, 1)
  assert.ok((await store.peek()) !== null, '写入失败不得删除 pending')
})

// ---------- Test 20：无 pending 时新页面零行为 ----------

test('pending: 无 pending → no-pending，composer 零触碰（页面零行为）', async () => {
  const store = new PendingHandoffStore(makeStorage())
  const { capability, calls } = fakeCapability({ composer: null })
  const result = await injectPendingHandoff(capability, store, { composerWaitMs: 100, pollIntervalMs: 20 })
  assert.equal(result, 'no-pending')
  assert.equal(calls.getComposer, 0)
  assert.equal(calls.setComposerText, 0)
})

// ---------- 注入成功路径 ----------

test('pending: 注入成功 → composer 写入 payload + consume 删除（不发送）', async () => {
  const store = new PendingHandoffStore(makeStorage())
  await store.save(PAYLOAD)
  const { capability, getLastText } = fakeCapability({ composer: { isConnected: true } as unknown as HTMLElement })
  const result = await injectPendingHandoff(capability, store, { composerWaitMs: 500, pollIntervalMs: 50 })
  assert.equal(result, 'injected')
  assert.equal(getLastText(), PAYLOAD)
  assert.equal(await store.peek(), null, '注入成功必须消费删除')
  // capability 接口只有"填草稿"，没有任何 send / submit 方法（产品约束的静态证明）
  assert.deepEqual(Object.keys(capability).sort(), ['getComposer', 'openNewConversation', 'setComposerText'])
})

test('pending: composer 迟迟不出现 → no-composer，pending 保留', async () => {
  const store = new PendingHandoffStore(makeStorage())
  await store.save(PAYLOAD)
  const { capability } = fakeCapability({ composer: null })
  const result = await injectPendingHandoff(capability, store, { composerWaitMs: 150, pollIntervalMs: 40 })
  assert.equal(result, 'no-composer')
  assert.ok((await store.peek()) !== null)
})

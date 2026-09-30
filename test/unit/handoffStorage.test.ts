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

// ---------- Test 16：consume（身份安全）后立即删除 ----------

test('pending: consume(expectedId) 命中时删除并返回 true，二次 consume 安全 false', async () => {
  const store = new PendingHandoffStore(makeStorage())
  await store.save(PAYLOAD)
  const pending = await store.peek()
  assert.ok(pending !== null)
  assert.equal(await store.consume(pending!.id), true, '身份匹配：真实删除')
  assert.equal(await store.peek(), null)
  assert.equal(await store.consume(pending!.id), false, '已不存在：安全 false，不得抛错')
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
  assert.equal(await store.consume('any-id'), false)
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

// ---------- Race Tests R1-R4：多标签页 / 注入窗口竞争（deterministic） ----------
// JS 单线程下竞争发生在 await 边界：用可控 fake storage 在步骤之间人为插入
// 覆盖写入，确定性地复现 TOCTOU 窗口。

const OTHER_PAYLOAD = '# TurnRail Context Handoff\n\n## Current Objective\nTab B 的另一份 handoff。'

// Race Test R1：Tab A peek A → Tab B save B → Tab A consume(A.id)
test('race R1: 旧消费者 consume(A) 绝不删除覆盖写入的 B', async () => {
  const store = new PendingHandoffStore(makeStorage())
  await store.save(PAYLOAD)
  const a = await store.peek()
  assert.ok(a !== null)

  await store.save(OTHER_PAYLOAD) // Tab B 在 A 消费前覆盖
  const removed = await store.consume(a!.id)

  assert.equal(removed, false, '身份不匹配：不得删除')
  const current = await store.peek()
  assert.ok(current !== null, 'B 必须仍然存在')
  assert.equal(current!.payload, OTHER_PAYLOAD)
})

// Race Test R2：读取到过期 A → 过期清理复读前 B 覆盖写入
test('race R2: 过期清理也是身份安全的 —— 覆盖写入的新 B 不被误删', async () => {
  const now = Date.now()
  const data = new Map<string, unknown>()
  data.set(PENDING_HANDOFF_KEY, {
    schemaVersion: 1,
    id: 'handoff-A-expired',
    createdAt: now - PENDING_HANDOFF_TTL_MS * 2,
    expiresAt: now - PENDING_HANDOFF_TTL_MS,
    sourceProvider: 'chatgpt',
    payload: PAYLOAD
  })
  // removeIfMatches 复读 storage 的那一刻，Tab B 恰好覆盖写入新 pending：
  // 守卫必须因 id 不匹配而放弃删除，让 B 存活
  let reRead = false
  const storage = {
    get: async (key: string) => {
      if (reRead) {
        data.set(key, {
          schemaVersion: 1,
          id: 'handoff-B',
          createdAt: Date.now(),
          expiresAt: Date.now() + PENDING_HANDOFF_TTL_MS,
          sourceProvider: 'chatgpt',
          payload: OTHER_PAYLOAD
        })
      }
      reRead = true
      return { [key]: data.get(key) }
    },
    set: async (items: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(items)) data.set(k, v)
    },
    remove: async (key: string) => {
      data.delete(key)
    }
  }
  const store = new PendingHandoffStore(storage)

  assert.equal(await store.peek(), null, '过期 A 必须作废（返回 null）')
  const current = await store.peek()
  assert.ok(current !== null, '覆盖写入的 B 不得被过期 A 的清理误删')
  assert.equal(current!.id, 'handoff-B')
  assert.equal(current!.payload, OTHER_PAYLOAD)
})

// Race Test R3：Injector A 已 peek → 期间 save B → 注入成功 → consume(A.id)
test('race R3: 注入窗口内 pending 被替换 → composer 收到 A，B 完整保留，结果仍 injected', async () => {
  const store = new PendingHandoffStore(makeStorage())
  await store.save(PAYLOAD)
  const a = await store.peek()
  assert.ok(a !== null)

  let lastText: string | null = null
  // setComposerText 执行期间，另一 tab 覆盖写入 B
  const capability: ConversationContinuationCapability = {
    getComposer: () => ({ isConnected: true }) as unknown as HTMLElement,
    setComposerText: (text: string) => {
      void store.save(OTHER_PAYLOAD)
      lastText = text
      return true
    },
    openNewConversation: () => undefined
  }

  const result = await injectPendingHandoff(capability, store, { composerWaitMs: 100, pollIntervalMs: 20 })
  assert.equal(lastText, PAYLOAD, 'A 的正文必须真实写入 composer')
  assert.equal(result, 'injected', 'A 已成功注入：消费竞争不算注入失败')
  const current = await store.peek()
  assert.ok(current !== null, 'B 必须保留')
  assert.equal(current!.payload, OTHER_PAYLOAD)
})

// Race Test R4：两个 consumer 消费同一 pending
test('race R4: 双消费者同一 pending —— 只有一次真实删除，第二次安全 false 且不误删后续数据', async () => {
  const store = new PendingHandoffStore(makeStorage())
  await store.save(PAYLOAD)
  const a = await store.peek()
  assert.ok(a !== null)

  const first = await store.consume(a!.id)
  const second = await store.consume(a!.id)
  assert.equal(first, true)
  assert.equal(second, false, '第二次消费安全 false')

  // 之后写入的新 pending 不受任何残留状态影响
  await store.save(OTHER_PAYLOAD)
  const current = await store.peek()
  assert.ok(current !== null)
  assert.equal(current!.payload, OTHER_PAYLOAD)
})

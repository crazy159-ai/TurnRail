import test from 'node:test'
import assert from 'node:assert/strict'
import { ConversationCacheStore } from '../../src/cache/cacheStore.ts'
import type { ExtensionContextState, StorageAreaLike } from '../../src/cache/types.ts'
import { makeCached, makeStorage } from './helpers.ts'

/**
 * v1.2.3 Cache Runtime Lifecycle 单元测试矩阵：
 * expected lifecycle（Extension context invalidated）与未知 storage 故障严格区分；
 * unavailable 是 terminal 状态 —— 只允许一次转换，此后所有方法短路，
 * 绝不再触碰 chrome.storage（terminal circuit breaker）。
 */

const INVALIDATED = 'Extension context invalidated.'

interface CallCounter {
  get: number
  set: number
  remove: number
}

/** 计数 fake storage：每次调用先计数；failWith 存在时计数后抛出该值 */
function countingStorage(failWith?: unknown): { calls: CallCounter; storage: StorageAreaLike } {
  const calls: CallCounter = { get: 0, set: 0, remove: 0 }
  const base = makeStorage()
  return {
    calls,
    storage: {
      async get(key: string) {
        calls.get++
        if (failWith !== undefined) throw failWith
        return base.get(key)
      },
      async set(items: Record<string, unknown>) {
        calls.set++
        if (failWith !== undefined) throw failWith
        return base.set(items)
      },
      async remove(key: string) {
        calls.remove++
        if (failWith !== undefined) throw failWith
        return base.remove(key)
      }
    }
  }
}

/** 统计 console.warn / console.error 调用次数（测试结束恢复原实现） */
function captureConsole(): { warns: () => number; errors: () => number; restore: () => void } {
  let warns = 0
  let errors = 0
  const originalWarn = console.warn
  const originalError = console.error
  console.warn = () => {
    warns++
  }
  console.error = () => {
    errors++
  }
  return {
    warns: () => warns,
    errors: () => errors,
    restore: () => {
      console.warn = originalWarn
      console.error = originalError
    }
  }
}

/** terminal 断路器：invalidation 后连续 100 次全量 API，storage 计数不得增长 */
async function hammerAfterInvalidation(cacheStore: ConversationCacheStore, calls: CallCounter): Promise<void> {
  for (let i = 0; i < 100; i++) {
    assert.equal(await cacheStore.get('chatgpt', 'conv-1'), null)
    assert.equal(await cacheStore.put(makeCached('conv-1', ['A'])), false)
    assert.equal(await cacheStore.touch('chatgpt', 'conv-1'), false)
    assert.equal(await cacheStore.remove('chatgpt', 'conv-1'), false)
    assert.equal(await cacheStore.setPinned('chatgpt', 'conv-1', true), false)
    assert.equal(await cacheStore.clear(), false)
    assert.equal((await cacheStore.list()).length, 0)
  }
  assert.equal(calls.get, 1, 'terminal 后 storage.get 不得再被调用')
  assert.equal(calls.set, 0, 'terminal 后 storage.set 不得再被调用')
  assert.equal(calls.remove, 0, 'terminal 后 storage.remove 不得再被调用')
}

// ---------- 1. 启动可用 ----------

test('lifecycle: 启动注入 fake storage → available，reason 为 null', async () => {
  const { storage } = countingStorage()
  const cacheStore = new ConversationCacheStore({ storage })
  assert.equal(cacheStore.isAvailable(), true)
  assert.equal(cacheStore.getUnavailableReason(), null)
  assert.equal(cacheStore.getStats().available, true)
  assert.equal(await cacheStore.get('chatgpt', 'conv-404'), null) // 正常 miss
  assert.equal(cacheStore.isAvailable(), true)
})

// ---------- 2. missing-api ----------

test('lifecycle: 无 storage → missing-api（terminal），一切 no-op', async () => {
  const cacheStore = new ConversationCacheStore(null)
  assert.equal(cacheStore.isAvailable(), false)
  assert.equal(cacheStore.getUnavailableReason(), 'missing-api')
  assert.equal(await cacheStore.get('chatgpt', 'conv-1'), null)
  assert.equal(await cacheStore.put(makeCached('conv-1', ['A'])), false)
  assert.equal(await cacheStore.remove('chatgpt', 'conv-1'), false)
  assert.equal(await cacheStore.touch('chatgpt', 'conv-1'), false)
  assert.equal(await cacheStore.setPinned('chatgpt', 'conv-1', true), false)
  assert.equal(await cacheStore.clear(), false)
  assert.equal((await cacheStore.list()).length, 0)
})

// ---------- 3. probe 提前发现失效（pre-flight） ----------

test('lifecycle: probe invalid → storage 零调用，直接 terminal context-invalidated', async () => {
  const { calls, storage } = countingStorage()
  const cacheStore = new ConversationCacheStore({ storage, contextProbe: () => 'invalid' })
  // isAvailable 不做 probe：状态仍为 available（UI 不因此抖动）
  assert.equal(cacheStore.isAvailable(), true)

  assert.equal(await cacheStore.get('chatgpt', 'conv-1'), null)
  assert.equal(cacheStore.isAvailable(), false)
  assert.equal(cacheStore.getUnavailableReason(), 'extension-context-invalidated')
  assert.equal(cacheStore.getStats().available, false)
  assert.equal(calls.get, 0, 'pre-flight probe 生效：storage.get 调用次数必须为 0')
  assert.equal(calls.set, 0)
  assert.equal(calls.remove, 0)
})

// ---------- 4. TOCTOU：probe alive → storage 调用瞬间失效（catch fallback） ----------

test('lifecycle: probe alive + storage.get 抛 invalidated → catch 兜底 terminal + 0 warning', async () => {
  const { calls, storage } = countingStorage(new Error(INVALIDATED))
  const cacheStore = new ConversationCacheStore({ storage, contextProbe: () => 'alive' })
  const consoleCapture = captureConsole()
  try {
    assert.equal(await cacheStore.get('chatgpt', 'conv-1'), null)
    assert.equal(cacheStore.isAvailable(), false)
    assert.equal(cacheStore.getUnavailableReason(), 'extension-context-invalidated')
    assert.equal(consoleCapture.warns(), 0, '预期生命周期事件不得产生 warning')
    assert.equal(consoleCapture.errors(), 0)
  } finally {
    consoleCapture.restore()
  }
  await hammerAfterInvalidation(cacheStore, calls)
})

// ---------- 5. 字符串异常 ----------

test('lifecycle: 字符串 "Extension context invalidated." 也能识别为预期生命周期', async () => {
  const { storage } = countingStorage(INVALIDATED)
  const cacheStore = new ConversationCacheStore({ storage, contextProbe: () => 'alive' })
  const consoleCapture = captureConsole()
  try {
    assert.equal(await cacheStore.get('chatgpt', 'conv-1'), null)
    assert.equal(cacheStore.getUnavailableReason(), 'extension-context-invalidated')
    assert.equal(consoleCapture.warns(), 0)
  } finally {
    consoleCapture.restore()
  }
})

// ---------- 6. 未知 storage error 仍必须 reportError ----------

test('lifecycle: 未知 storage 错误 → storage-error + reportError 恰一次，后续 no-op 不再增加', async () => {
  const { calls, storage } = countingStorage(new Error('storage backend exploded'))
  const cacheStore = new ConversationCacheStore({ storage, contextProbe: () => 'alive' })
  const consoleCapture = captureConsole()
  try {
    assert.equal(await cacheStore.get('chatgpt', 'conv-1'), null)
    assert.equal(cacheStore.isAvailable(), false)
    assert.equal(cacheStore.getUnavailableReason(), 'storage-error')
    assert.equal(consoleCapture.warns(), 1, '真实 storage 故障必须 reportError 一次')
    assert.equal(consoleCapture.errors(), 0)

    // terminal：后续调用不再 reportError（转换只发生一次）
    for (let i = 0; i < 50; i++) {
      assert.equal(await cacheStore.get('chatgpt', 'conv-1'), null)
      assert.equal(await cacheStore.put(makeCached('conv-1', ['A'])), false)
    }
    assert.equal(consoleCapture.warns(), 1)
  } finally {
    consoleCapture.restore()
  }
  await hammerAfterInvalidation(cacheStore, calls)
})

// ---------- 7. terminal circuit breaker（异常后 100 次全量 API） ----------

test('lifecycle: invalidation 后 100 轮全量 API → storage 计数不增长（terminal breaker）', async () => {
  const { calls, storage } = countingStorage(new Error(INVALIDATED))
  const cacheStore = new ConversationCacheStore({ storage, contextProbe: () => 'unknown' })
  const consoleCapture = captureConsole()
  try {
    assert.equal(await cacheStore.get('chatgpt', 'conv-1'), null)
    assert.equal(cacheStore.getUnavailableReason(), 'extension-context-invalidated')
    await hammerAfterInvalidation(cacheStore, calls)
    assert.equal(consoleCapture.warns(), 0)
  } finally {
    consoleCapture.restore()
  }
})

// ---------- 8. probe 迟后变 invalid：下一次操作前被 pre-flight 拦截 ----------

test('lifecycle: probe 由 alive 变 invalid → 下次操作零 storage 调用并 terminal 转换', async () => {
  const { calls, storage } = countingStorage()
  let context: ExtensionContextState = 'alive'
  const cacheStore = new ConversationCacheStore({ storage, contextProbe: () => context })

  // 第一次读取正常（miss）：storage.get 计数 1
  assert.equal(await cacheStore.get('chatgpt', 'conv-1'), null)
  assert.equal(calls.get, 1)
  assert.equal(cacheStore.isAvailable(), true)

  // 扩展在两次操作之间被重载：probe 现在发现失效
  context = 'invalid'
  assert.equal(await cacheStore.get('chatgpt', 'conv-1'), null)
  assert.equal(await cacheStore.put(makeCached('conv-1', ['A'])), false)
  assert.equal(cacheStore.isAvailable(), false)
  assert.equal(cacheStore.getUnavailableReason(), 'extension-context-invalidated')
  assert.equal(calls.get, 1, 'pre-flight probe 必须拦截：storage.get 计数不变')
  assert.equal(calls.set, 0)
  assert.equal(calls.remove, 0)
})

// ---------- 9. unknown probe：测试 / mock 环境不误判 ----------

test('lifecycle: probe unknown → fake storage 正常 get/put 往返', async () => {
  const { calls, storage } = countingStorage()
  const cacheStore = new ConversationCacheStore({ storage, contextProbe: () => 'unknown' })
  assert.equal(await cacheStore.put(makeCached('conv-1', ['A', 'B'])), true)
  const loaded = await cacheStore.get('chatgpt', 'conv-1')
  assert.ok(loaded !== null)
  assert.equal(loaded!.turnCount, 2)
  assert.equal(await cacheStore.touch('chatgpt', 'conv-1'), true)
  assert.equal(await cacheStore.remove('chatgpt', 'conv-1'), true)
  assert.equal(calls.set > 0, true)
  assert.equal(cacheStore.isAvailable(), true)
})

// ---------- 10. transition 幂等：状态只转换一次且稳定 ----------

test('lifecycle: terminal 转换只发生一次 —— 重复调用后 reason / 可用性 / 计数稳定', async () => {
  const { calls, storage } = countingStorage(new Error(INVALIDATED))
  const cacheStore = new ConversationCacheStore({ storage, contextProbe: () => 'unknown' })
  const consoleCapture = captureConsole()
  try {
    await cacheStore.get('chatgpt', 'conv-1')
    const reason = cacheStore.getUnavailableReason()
    for (let i = 0; i < 20; i++) {
      await cacheStore.get('chatgpt', 'conv-1')
      await cacheStore.put(makeCached('conv-1', ['A']))
      await cacheStore.list()
      assert.equal(cacheStore.getUnavailableReason(), reason)
      assert.equal(cacheStore.isAvailable(), false)
      assert.equal(cacheStore.getStats().available, false)
    }
    assert.equal(reason, 'extension-context-invalidated')
    assert.equal(consoleCapture.warns(), 0)
    assert.equal(consoleCapture.errors(), 0)
  } finally {
    consoleCapture.restore()
  }
  assert.equal(calls.get, 1)
})

// ---------- 11. 构造形式兼容 ----------

test('lifecycle: options 构造与旧位置参数构造行为一致', async () => {
  // 旧形式：位置参数 storage
  const legacy = new ConversationCacheStore(makeStorage())
  assert.equal(await legacy.put(makeCached('conv-legacy', ['A'])), true)
  assert.ok((await legacy.get('chatgpt', 'conv-legacy')) !== null)

  // 新形式：options（storage + contextProbe 注入）
  const options = new ConversationCacheStore({ storage: makeStorage(), contextProbe: () => 'alive' })
  assert.equal(await options.put(makeCached('conv-options', ['A'])), true)
  assert.ok((await options.get('chatgpt', 'conv-options')) !== null)

  // 新形式：显式 null storage = missing-api
  const explicitNull = new ConversationCacheStore({ storage: null })
  assert.equal(explicitNull.getUnavailableReason(), 'missing-api')
})

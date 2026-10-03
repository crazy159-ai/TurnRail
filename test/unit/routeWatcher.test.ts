import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createRouteWatcher,
  type NavigationLike,
  type RouteChange,
  type RouteWatcherEvents,
  type RouteWatcherTimers
} from '../../src/content/routeWatcher.ts'
import {
  readRouteIdentity,
  routeIdentityKey,
  type RouteIdentity
} from '../../src/content/routeIdentity.ts'

/**
 * RouteWatcher 契约测试（RW1–RW9，规格 #49）：
 * Navigation API 主路径 / popstate / 轮询兜底 / 严格去重 / focus / visibility
 * 恢复探测 / cleanup。全部注入假事件与假时钟，零真实等待。
 *
 * 核心不变量：多来源看到同一次导航时 onChange 只触发一次（规格 #13）；
 * identity 相同（同会话 query/hash 变化）绝不触发（规格 #6/#8）。
 */

// ---------- 假环境 ----------

interface FakeEnv {
  env: RouteWatcherEvents & { fire(type: string): void }
  timers: RouteWatcherTimers & { advance(ms: number): void; intervalCount(): number }
}

function makeFakeEnv(): FakeEnv {
  const windowListeners = new Map<string, () => void>()
  const documentListeners = new Map<string, () => void>()
  interface Slot {
    callback: () => void
    every: number
    next: number
  }
  const intervals = new Set<Slot>()
  let now = 0

  return {
    env: {
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
      fire(type) {
        windowListeners.get(type)?.()
        documentListeners.get(type)?.()
      }
    },
    timers: {
      setInterval(callback, ms) {
        const slot: Slot = { callback, every: ms, next: now + ms }
        intervals.add(slot)
        return slot
      },
      clearInterval(handle) {
        intervals.delete(handle as Slot)
      },
      intervalCount() {
        return intervals.size
      },
      advance(ms) {
        const target = now + ms
        while (now < target) {
          now++
          for (const slot of [...intervals]) {
            if (now >= slot.next && intervals.has(slot)) {
              slot.next += slot.every
              slot.callback()
            }
          }
        }
      }
    }
  }
}

/** 模拟 ChatGptProvider 的会话 ID 提取：/c/<id> 语义由测试侧持有（RouteWatcher 不认识站点） */
function makeIdentitySource() {
  const source = {
    pathname: '/c/conv-aaa',
    navigate(path: string) {
      source.pathname = path
      // readRouteIdentity 的非会话分支读取 location.pathname —— 同步更新桩
      ;(globalThis as Record<string, unknown>).location = { pathname: path }
    },
    getIdentity: (): RouteIdentity => {
      const match = source.pathname.match(/\/c\/([A-Za-z0-9-]{8,})/)
      const id = match ? (match[1] ?? null) : null
      return readRouteIdentity(() => id)
    }
  }
  ;(globalThis as Record<string, unknown>).location = { pathname: source.pathname }
  return source
}

/** Node 环境的 document 桩（visibilitychange 判定用，测试间恢复） */
function withDocumentStub<T>(visibilityState: string, fn: () => T): T {
  const previous = (globalThis as Record<string, unknown>).document
  ;(globalThis as Record<string, unknown>).document = { visibilityState }
  try {
    return fn()
  } finally {
    ;(globalThis as Record<string, unknown>).document = previous
  }
}

function conversation(id: string): RouteIdentity {
  return { kind: 'conversation', conversationId: id }
}

// ---------- routeIdentity 纯函数 ----------

test('routeIdentity: key 格式 conversation:/page: 且排除 query / hash 噪声', () => {
  assert.equal(routeIdentityKey(conversation('abc123')), 'conversation:abc123')
  assert.equal(routeIdentityKey({ kind: 'non-conversation', path: '/' }), 'page:/')
  assert.equal(routeIdentityKey({ kind: 'non-conversation', path: '/gpts' }), 'page:/gpts')
})

test('routeIdentity: readRouteIdentity 依赖 Provider 提取会话 ID，非会话取 pathname', () => {
  const source = makeIdentitySource()
  assert.deepEqual(source.getIdentity(), conversation('conv-aaa'))
  source.navigate('/')
  assert.deepEqual(source.getIdentity(), { kind: 'non-conversation', path: '/' })
})

// ---------- RW1–RW9 ----------

test('RW1: Navigation API currententrychange → 立即回调（事件驱动，零轮询延迟）', () => {
  const { env, timers } = makeFakeEnv()
  const source = makeIdentitySource()
  const nav = new EventTarget() as unknown as NavigationLike
  const changes: RouteChange[] = []

  createRouteWatcher(source.getIdentity, (change) => changes.push(change), {
    navigationApi: nav,
    events: env,
    timers
  })

  source.navigate('/c/conv-bbbb-2222')
  nav.dispatchEvent(new Event('currententrychange'))

  assert.equal(changes.length, 1)
  assert.equal(changes[0]!.source, 'navigation-api')
  assert.deepEqual(changes[0]!.previous, conversation('conv-aaa'))
  assert.deepEqual(changes[0]!.current, conversation('conv-bbbb-2222'))
  // 未推进任何虚拟时间 → 证明不是 poll 兜底（规格 #40 的单元级根据）
  assert.equal(timers.intervalCount(), 1, '轮询兜底仍保留（correctness fallback）')
})

test('RW2: 无 Navigation API → 轮询兜底检出身份变化', () => {
  const { env, timers } = makeFakeEnv()
  const source = makeIdentitySource()
  const changes: RouteChange[] = []

  createRouteWatcher(source.getIdentity, (change) => changes.push(change), {
    navigationApi: null,
    pollMs: 300,
    events: env,
    timers
  })

  source.navigate('/c/conv-bbbb-2222')
  timers.advance(299)
  assert.equal(changes.length, 0)
  timers.advance(1)
  assert.equal(changes.length, 1)
  assert.equal(changes[0]!.source, 'poll')
})

test('RW3: popstate（前进 / 后退）→ 立即回调', () => {
  const { env, timers } = makeFakeEnv()
  const source = makeIdentitySource()
  const changes: RouteChange[] = []

  createRouteWatcher(source.getIdentity, (change) => changes.push(change), {
    navigationApi: null,
    events: env,
    timers
  })

  source.navigate('/')
  env.fire('popstate')

  assert.equal(changes.length, 1)
  assert.equal(changes[0]!.source, 'popstate')
  assert.deepEqual(changes[0]!.current, { kind: 'non-conversation', path: '/' })
})

test('RW4: 多来源看到同一次导航 → 严格去重，onChange 只触发一次', () => {
  const { env, timers } = makeFakeEnv()
  const source = makeIdentitySource()
  const changes: RouteChange[] = []
  const nav = new EventTarget() as unknown as NavigationLike

  const stop = createRouteWatcher(source.getIdentity, (change) => changes.push(change), {
    navigationApi: nav,
    pollMs: 100,
    events: env,
    timers
  })

  source.navigate('/c/conv-bbbb-2222')
  nav.dispatchEvent(new Event('currententrychange'))
  env.fire('popstate')
  env.fire('focus')
  timers.advance(500)

  assert.equal(changes.length, 1, '同一次导航只允许一次 onChange')
  assert.equal(changes[0]!.source, 'navigation-api', '第一个来源胜出')
  const metrics = stop.metrics()
  assert.equal(metrics.detected, 1)
  // dedupe：popstate + focus（同一次导航的重复信号）+ 5 次 poll tick（100ms × 500ms）
  assert.equal(metrics.duplicateIgnored, 7)
  assert.equal(metrics.transitions, 1)
})

test('RW5: 同会话 query 变化（pathname 不变）→ 身份相同，绝不触发', () => {
  const { env, timers } = makeFakeEnv()
  const source = makeIdentitySource()
  const changes: RouteChange[] = []
  const nav = new EventTarget() as unknown as NavigationLike

  const handle = createRouteWatcher(source.getIdentity, (change) => changes.push(change), {
    navigationApi: nav,
    events: env,
    timers
  })

  // /c/conv-aaa?model=x → /c/conv-aaa?model=y：pathname 层面完全一致
  nav.dispatchEvent(new Event('currententrychange'))
  env.fire('popstate')
  timers.advance(1000)

  assert.equal(changes.length, 0, '同会话 query 变化不得重置（规格 #8）')
  const metrics = handle.metrics()
  assert.equal(metrics.detected, 0)
  assert.ok(metrics.duplicateIgnored > 0)
  handle()
})

test('RW6: /c/AAA → /c/BBB 与 / → /c/BBB 均判定为路由身份变化', () => {
  const { env, timers } = makeFakeEnv()
  const source = makeIdentitySource()
  const changes: RouteChange[] = []

  createRouteWatcher(source.getIdentity, (change) => changes.push(change), {
    navigationApi: null,
    events: env,
    timers
  })

  source.navigate('/c/conv-bbbb-2222')
  env.fire('popstate')
  assert.equal(changes.length, 1)
  assert.deepEqual(changes[0]!.previous, conversation('conv-aaa'))
  assert.deepEqual(changes[0]!.current, conversation('conv-bbbb-2222'))

  source.navigate('/')
  env.fire('popstate')
  assert.equal(changes.length, 2)
  assert.deepEqual(changes[1]!.current, { kind: 'non-conversation', path: '/' })

  source.navigate('/c/conv-cccc-3333')
  env.fire('popstate')
  assert.equal(changes.length, 3)
  assert.deepEqual(changes[2]!.previous, { kind: 'non-conversation', path: '/' })
})

test('RW7: cleanup → 移除监听、清除轮询、stop 后探测失效', () => {
  const { env, timers } = makeFakeEnv()
  const source = makeIdentitySource()
  const changes: RouteChange[] = []
  const nav = new EventTarget() as unknown as NavigationLike

  const stop = createRouteWatcher(source.getIdentity, (change) => changes.push(change), {
    navigationApi: nav,
    events: env,
    timers
  })

  assert.equal(timers.intervalCount(), 1)
  stop()
  assert.equal(timers.intervalCount(), 0, '轮询必须被清除')

  const metricsAtStop = stop.metrics()
  source.navigate('/c/conv-bbbb-2222')
  nav.dispatchEvent(new Event('currententrychange'))
  env.fire('popstate')
  env.fire('focus')
  timers.advance(2000)

  assert.equal(changes.length, 0, 'stop 后不得再触发')
  assert.deepEqual(stop.metrics(), metricsAtStop, 'stop 后计数冻结')
})

test('RW8: window focus 立即探测路由（后台 tab 计时器被节流的恢复路径）', () => {
  withDocumentStub('visible', () => {
    const { env, timers } = makeFakeEnv()
    const source = makeIdentitySource()
    const changes: RouteChange[] = []

    createRouteWatcher(source.getIdentity, (change) => changes.push(change), {
      navigationApi: null,
      pollMs: 3_600_000,
      events: env,
      timers
    })

    source.navigate('/c/conv-bbbb-2222')
    env.fire('focus')

    assert.equal(changes.length, 1)
    assert.equal(changes[0]!.source, 'focus')
  })
})

test('RW9: visibilitychange → visible 立即探测；hidden 不探测', () => {
  withDocumentStub('visible', () => {
    const { env, timers } = makeFakeEnv()
    const source = makeIdentitySource()
    const changes: RouteChange[] = []

    createRouteWatcher(source.getIdentity, (change) => changes.push(change), {
      navigationApi: null,
      pollMs: 3_600_000,
      events: env,
      timers
    })

    // hidden：不产生探测（无路由信息）
    withDocumentStub('hidden', () => {
      source.navigate('/c/conv-bbbb-2222')
      env.fire('visibilitychange')
    })
    assert.equal(changes.length, 0, 'hidden 时不得探测')

    // visible：立即探测
    env.fire('visibilitychange')
    assert.equal(changes.length, 1)
    assert.equal(changes[0]!.source, 'visibility')
  })
})

test('RW 补充: Navigation API 缺席时 feature detect 不依赖 window（Node 环境可构造）', () => {
  const { env, timers } = makeFakeEnv()
  const source = makeIdentitySource()
  const changes: RouteChange[] = []

  // navigationApi 未注入 → 运行时 feature detect；Node 无 window.navigation →
  // 自动降级为 poll + popstate，绝不抛错（规格 #50）
  const stop = createRouteWatcher(source.getIdentity, (change) => changes.push(change), {
    pollMs: 50,
    events: env,
    timers
  })

  source.navigate('/c/conv-bbbb-2222')
  timers.advance(60)
  assert.equal(changes.length, 1)
  assert.equal(changes[0]!.source, 'poll')
  stop()
})

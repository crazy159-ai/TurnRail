import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { ConversationStore } from '../../src/conversation/store.ts'
import { ConversationIndexer } from '../../src/conversation/indexer.ts'
import {
  computeHistoryCoverage,
  historyCoverageLabel
} from '../../src/conversation/historyCoverage.ts'
import {
  createPassiveTopWatch,
  type TopWatchTimers
} from '../../src/content/passiveTopWatch.ts'
import { hydrateCachedConversation } from '../../src/cache/hydrator.ts'
import { fakeProvider, liveTurn, makeCached, makeTurn, fakeElement } from './helpers.ts'
import type { CachedConversation, CachedTurn } from '../../src/cache/types.ts'
import type { StoreEvent } from '../../src/conversation/store.ts'
import type { LocatedTurn } from '../../src/providers/types.ts'

/**
 * Passive History Harvest 合同（Passive History Harvest Hardening）：
 *
 * 1. BACKGROUND_TASK_MUST_NOT_SCROLL —— 源码级合同：除用户显式动作路径
 *    （jump / recover / manual capture / scrollAnchor / 几何层）外，
 *    任何模块不得写 scrollTop / 调用 scrollTo / scrollBy / scrollIntoView /
 *    moveTowardVisual*。TurnRail 绝不为补全历史主动滚动当前聊天。
 * 2. coverage 语义 —— computeHistoryCoverage / coverageRevision /
 *    preview → full 升级必须广播 'coverage' 事件（即使文本完全相同），
 *    健康覆盖度与目录"仅预览"标记依赖它。
 * 3. detached ≠ 未收获 —— virtualization 卸载不降级、正文保留。
 * 4. 被动到顶证据 —— passiveTopWatch 只监听不滚动，证据保守。
 */

// scrollGeometry 读取 window.getComputedStyle（仅调用时）；Node 环境提供最小 stub
;(globalThis as unknown as Record<string, unknown>).window = {
  getComputedStyle: () => ({ flexDirection: 'column' })
}

interface FakeElementLike {
  isConnected: boolean
}

// ---------- 1. BACKGROUND_TASK_MUST_NOT_SCROLL（源码级合同） ----------

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')

/** 允许写 scrollTop / scrollTo / scrollBy / moveToward* 的模块：
 *  全部是用户显式动作路径（点击跳转 / recover / 「加载全部历史」）或被它们
 *  唯一复用的几何与锚点层。后台 / 被动 / 观察模块一律不得出现在此名单。 */
const SCROLL_WRITE_ALLOWLIST = new Set([
  'navigation/scrollGeometry.ts',
  'navigation/scrollAnchor.ts',
  'navigation/jump.ts',
  'navigation/recoverTarget.ts',
  'conversation/historyCapture.ts'
])

/** scrollIntoView 只允许出现在 ui/（目录面板自身列表滚动，与聊天滚动容器无关） */
function scrollIntoViewAllowed(relPath: string): boolean {
  return relPath.startsWith('ui')
}

const SCROLL_WRITE_PATTERN =
  /\.scrollTop\s*=[^=]|\bscrollTo\s*\(|\bscrollBy\s*\(|moveTowardVisual(?:Top|Bottom)\s*\(/
const SCROLL_INTO_VIEW_PATTERN = /\bscrollIntoView\s*\(/
/** 声明 / 读取形如 `const scrollTop = ...` 不含点号前缀，不会被 `\.scrollTop =` 误匹配 */

function listSourceFiles(dir: string, into: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) listSourceFiles(full, into)
    else if (entry.name.endsWith('.ts')) into.push(full)
  }
  return into
}

test('合同: 后台模块绝不滚动 —— 滚动写入只存在于用户显式动作路径', () => {
  const violations: string[] = []
  for (const file of listSourceFiles(SRC_ROOT)) {
    const rel = path.relative(SRC_ROOT, file).split(path.sep).join('/')
    const text = readFileSync(file, 'utf8')
    if (SCROLL_WRITE_PATTERN.test(text) && !SCROLL_WRITE_ALLOWLIST.has(rel)) {
      violations.push(rel)
    }
    if (SCROLL_INTO_VIEW_PATTERN.test(text) && !scrollIntoViewAllowed(rel)) {
      violations.push(`${rel} (scrollIntoView)`)
    }
  }
  assert.deepEqual(
    violations,
    [],
    `以下模块包含滚动写入，但不在用户动作白名单内: ${violations.join(', ')}`
  )
})

test('合同: 被动历史模块不包含任何滚动写入（白名单之外的双保险）', () => {
  const passiveModules = [
    'conversation/historyCoverage.ts',
    'content/passiveTopWatch.ts',
    'content/bootstrap.ts',
    'content/mutationPipeline.ts',
    'conversation/indexer.ts',
    'conversation/store.ts',
    'ui/createShadowRoot.ts'
  ]
  for (const rel of passiveModules) {
    const text = readFileSync(path.join(SRC_ROOT, ...rel.split('/')), 'utf8')
    assert.equal(SCROLL_WRITE_PATTERN.test(text), false, `${rel} 不得写 scrollTop / scrollTo`)
    assert.equal(SCROLL_INTO_VIEW_PATTERN.test(text), false, `${rel} 不得调用 scrollIntoView`)
  }
})

// ---------- 2. coverage 语义 ----------

function messageOf(id: string, text: string, completeness?: 'full' | 'preview') {
  return {
    id,
    role: 'user' as const,
    text,
    turnIndex: 0,
    element: undefined,
    firstSeenAt: 0,
    isMounted: false,
    contentCompleteness: completeness
  }
}

test('coverage: computeHistoryCoverage 统计 full / preview / missing assistant', () => {
  const store = new ConversationStore()
  store.reset('conv-1')
  const mounted = liveTurn('q1', '完整问题')
  store.messages.set('q1', {
    ...messageOf('q1', '完整问题', 'full'),
    element: mounted.user!.element,
    isMounted: true
  })
  store.messages.set('q2', messageOf('q2', '预览问题', 'preview'))
  store.turns = [
    {
      id: 'q1',
      index: 0,
      user: store.messages.get('q1'),
      assistant: {
        id: 'q1-a',
        role: 'assistant',
        text: '回答',
        turnIndex: 0,
        element: mounted.assistant!.element,
        firstSeenAt: 0,
        isMounted: true,
        contentCompleteness: 'full'
      },
      title: 'q1',
      preview: ''
    },
    { id: 'q2', index: 1, user: store.messages.get('q2'), title: 'q2', preview: '' }
  ]

  const coverage = computeHistoryCoverage(store, false)
  assert.equal(coverage.indexedTurns, 2)
  assert.equal(coverage.fullUserTurns, 1)
  assert.equal(coverage.previewUserTurns, 1)
  assert.equal(coverage.fullAssistantTurns, 1)
  assert.equal(coverage.missingAssistantTurns, 1)
  assert.equal(coverage.state, 'partial')

  const complete = computeHistoryCoverage(store, true)
  assert.equal(complete.state, 'partial', '仍有 preview → 不得报告 complete')

  const empty = computeHistoryCoverage(new ConversationStore(), true)
  assert.equal(empty.state, 'unknown')
})

test('coverage: reachedTop 且无 preview → complete（字段名与 Health confidence 正交）', () => {
  const store = new ConversationStore()
  store.reset('conv-1')
  const turn = liveTurn('q1', '完整问题')
  const indexer = new ConversationIndexer(fakeProvider([turn]), store)
  indexer.scan()

  assert.equal(computeHistoryCoverage(store, false).state, 'partial')
  assert.equal(computeHistoryCoverage(store, true).state, 'complete')
})

test('coverage: historyCoverageLabel 静态低干扰文案', () => {
  const store = new ConversationStore()
  store.reset('conv-1')
  assert.equal(historyCoverageLabel(computeHistoryCoverage(store, false)), '')

  const turn = liveTurn('q1', '完整问题')
  const indexer = new ConversationIndexer(fakeProvider([turn]), store)
  indexer.scan()
  assert.equal(historyCoverageLabel(computeHistoryCoverage(store, false)), '历史 1 · 部分')
  assert.equal(historyCoverageLabel(computeHistoryCoverage(store, true)), '历史 1 · 已补全')
})

test('coverageRevision: coverage 事件推进、semanticRevision 不动；structure 双推进', () => {
  const store = new ConversationStore()
  store.reset('conv-1')
  const initialSemantic = store.semanticRevision
  const initialCoverage = store.coverageRevision

  store.commit('coverage')
  assert.equal(store.coverageRevision, initialCoverage + 1)
  assert.equal(store.semanticRevision, initialSemantic, 'preview → full 语义未变')

  store.commit('structure')
  assert.equal(store.coverageRevision, initialCoverage + 2)
  assert.equal(store.semanticRevision, initialSemantic + 1)

  store.commit('assistant-text')
  store.commit('elements')
  assert.equal(store.coverageRevision, initialCoverage + 2)
  assert.equal(store.semanticRevision, initialSemantic + 1)

  store.reset('conv-2')
  assert.equal(store.semanticRevision, 0)
  assert.equal(store.coverageRevision, 0)
})

function previewOnlyCache(conversationId: string, entries: Array<[id: string, text: string]>): CachedConversation {
  const cached = makeCached(conversationId, entries.map(([id]) => id))
  const turns: CachedTurn[] = cached.turns.map((turn, i) => ({
    ...turn,
    // preview 与 Live 全文完全一致：升级时文本不变，必须仍上报 coverage
    preview: entries[i]![1]
  }))
  return { ...cached, turns }
}

test('合同: preview → full 即使文本完全相同也广播 coverage 事件（Health 感知回归）', () => {
  const store = new ConversationStore()
  store.reset('conv-1')
  const hydrated = hydrateCachedConversation(
    store,
    previewOnlyCache('conv-1', [['q1', '同一句完整提问'], ['q2', '第二句完整提问']])
  )
  assert.equal(hydrated, 2)
  const semanticBefore = store.semanticRevision
  const coverageBefore = store.coverageRevision

  const events: StoreEvent[] = []
  store.onChange((kind) => events.push(kind))

  // Live DOM 挂载：文本与 preview 完全一致（模拟"短提问本就无需截断"）
  const provider = fakeProvider([liveTurn('q1', '同一句完整提问'), liveTurn('q2', '第二句完整提问')])
  const indexer = new ConversationIndexer(provider, store)
  indexer.scan(true)

  assert.deepEqual(events, ['coverage'], '文本未变 → 唯一上报必须是 coverage，绝不能是 none')
  assert.equal(store.semanticRevision, semanticBefore, '语义修订号不得推进')
  assert.equal(store.coverageRevision, coverageBefore + 1, '覆盖修订号必须推进')
  assert.equal(store.turns[0]!.user?.contentCompleteness, 'full')

  // 健康缓存键 = semantic + coverage 组合：即使语义不动也会重算
  assert.notEqual(
    `${store.semanticRevision}:${store.coverageRevision}`,
    `${semanticBefore}:${coverageBefore}`
  )
})

test('合同: preview → full 与文本变化同批时补推 coverage（规格 #36 混合变更封板）', () => {
  const store = new ConversationStore()
  store.reset('conv-1')
  hydrateCachedConversation(store, previewOnlyCache('conv-1', [['q1', '截断的旧预览']]))

  const events: StoreEvent[] = []
  store.onChange((kind) => events.push(kind))

  const provider = fakeProvider([liveTurn('q1', '编辑后的完整提问')])
  const indexer = new ConversationIndexer(provider, store)
  indexer.scan(true)

  // 主事件 user-text（健康重算语义）+ 补推 coverage（覆盖度 / footer 语义）：
  // 不能因为 primary event 是 user-text 就漏掉 coverageRevision（规格 #36）
  assert.deepEqual(events, ['user-text', 'coverage'])
  assert.equal(store.turns[0]!.user?.contentCompleteness, 'full')
  // 健康缓存键 = conversationKey + semantic + coverage 组合：
  // 两个修订号都必须推进，覆盖度提升对任何下游消费方都不漏检
  assert.equal(store.coverageRevision, 1)
  assert.equal(store.semanticRevision, 1)
})

// ---------- 3. 目录加载状态标记（detached ≠ 未收获） ----------

test('badge: turnLoadFlag 区分 preview-only / not-loaded / 已完整收获', async () => {
  const { turnLoadFlag } = await import('../../src/ui/outline.ts')

  // preview：缓存 hydrate 的截断文本（无论是否挂载）→ 仅预览
  const previewTurn = makeTurn('q1', 0, '预览文本')
  previewTurn.user!.contentCompleteness = 'preview'
  assert.equal(turnLoadFlag(previewTurn), 'preview-only')

  // full + detached：正文已完整收获 → 不显示任何标记
  const fullDetached = makeTurn('q2', 1, '完整文本')
  fullDetached.user!.contentCompleteness = 'full'
  assert.equal(turnLoadFlag(fullDetached), null)

  // full + mounted → null
  const fullMounted = makeTurn('q3', 2, '完整文本')
  fullMounted.user!.contentCompleteness = 'full'
  fullMounted.user!.element = fakeElement(true)
  assert.equal(turnLoadFlag(fullMounted), null)

  // 无完整度记录且未挂载（保守兜底）→ 未加载
  const unknownDetached = makeTurn('q4', 3, '文本')
  assert.equal(turnLoadFlag(unknownDetached), 'not-loaded')

  // assistant-only turn → null
  const assistantOnly = makeTurn('q5', 4, '文本')
  assistantOnly.user = undefined
  assert.equal(turnLoadFlag(assistantOnly), null)
})

test('合同: 已完整收获的 turn 被 virtualization 卸载后不降级、正文保留', () => {
  const store = new ConversationStore()
  store.reset('conv-1')
  const turn = liveTurn('q1', '完整问题正文')
  const indexer = new ConversationIndexer(fakeProvider([turn]), store)

  indexer.scan()
  assert.equal(store.turns.length, 1)
  assert.equal(store.turns[0]!.user?.contentCompleteness, 'full')

  const disconnect = (el: FakeElementLike | undefined): void => {
    if (el) el.isConnected = false
  }
  disconnect(turn.root as FakeElementLike)
  disconnect(turn.user!.element as FakeElementLike)
  disconnect(turn.assistant!.element as FakeElementLike)
  indexer.scan()

  assert.equal(store.turns.length, 1, 'metadata 必须保留（detached）')
  assert.equal(store.turns[0]!.user?.contentCompleteness, 'full', 'full 不得降级')
  assert.equal(store.turns[0]!.user?.text, '完整问题正文', '正文必须保留')
  assert.equal(store.turns[0]!.assistant?.text, '完整问题正文 的回答')
})

test('合同: 卸载后重挂载 → full 保持、正文不丢失', () => {
  const store = new ConversationStore()
  store.reset('conv-1')
  const turn = liveTurn('q1', '完整问题正文')
  const indexer = new ConversationIndexer(fakeProvider([turn]), store)

  const setConnected = (value: boolean): void => {
    for (const el of [turn.root, turn.user!.element, turn.assistant!.element]) {
      ;(el as FakeElementLike).isConnected = value
    }
  }

  indexer.scan()
  setConnected(false)
  indexer.scan()
  setConnected(true)
  indexer.scan()

  assert.equal(store.turns.length, 1)
  assert.equal(store.turns[0]!.user?.contentCompleteness, 'full')
  assert.equal(store.turns[0]!.user?.text, '完整问题正文')
})

test('合同: assistant 原缺失 → 被动收获后 attach 且为 full', () => {
  const store = new ConversationStore()
  store.reset('conv-1')

  const userOnly = liveTurn('q1', '问题')
  const full = liveTurn('q1', '问题')
  let current: LocatedTurn[] = [{ id: 'q1', root: userOnly.root, user: userOnly.user }]
  const provider = { ...fakeProvider([]), locateTurns: () => current }
  const indexer = new ConversationIndexer(provider, store)
  indexer.scan()
  assert.ok(store.turns[0]!.assistant === undefined, '首阶段 assistant 缺失')

  current = [full]
  indexer.scan()

  const turnAfter = store.turns[0]!
  const assistant = turnAfter.assistant
  if (!assistant) throw new Error('assistant 必须被 attach')
  assert.equal(assistant.contentCompleteness, 'full')
  assert.equal(assistant.text, '问题 的回答')
})

// ---------- 4. 被动到顶证据（passiveTopWatch：只监听，绝不滚动） ----------

interface FakeScroller {
  el: HTMLElement
  dispatchScroll(): void
  listenerCount(): number
  state: { scrollTop: number }
}

/** 假滚动容器（normal 坐标系：scrollTop ∈ [0, 5000]，≤2 = 视觉顶部） */
function makeScroller(scrollTop: number): FakeScroller {
  const state = { scrollTop }
  let listener: (() => void) | null = null
  const el = {
    addEventListener: (type: string, handler: () => void) => {
      if (type === 'scroll') listener = handler
    },
    removeEventListener: (type: string) => {
      if (type === 'scroll') listener = null
    },
    get scrollTop() {
      return state.scrollTop
    },
    get scrollHeight() {
      return 6000
    },
    get clientHeight() {
      return 1000
    },
    getBoundingClientRect: () => ({ top: 0 })
  } as unknown as HTMLElement
  return {
    el,
    dispatchScroll: () => listener?.(),
    listenerCount: () => (listener === null ? 0 : 1),
    state
  }
}

class FakeClock {
  now = 0
  private seq = 0
  private tasks = new Map<number, { at: number; callback: () => void }>()

  timers(): TopWatchTimers {
    return {
      setTimeout: (callback, ms) => {
        const id = ++this.seq
        this.tasks.set(id, { at: this.now + ms, callback })
        return id
      },
      clearTimeout: (handle) => {
        this.tasks.delete(handle as number)
      }
    }
  }

  async advance(ms: number): Promise<void> {
    const target = this.now + ms
    for (;;) {
      let nextId: number | undefined
      let nextAt = Number.POSITIVE_INFINITY
      for (const [id, task] of this.tasks) {
        if (task.at <= target && task.at < nextAt) {
          nextAt = task.at
          nextId = id
        }
      }
      if (nextId === undefined) break
      this.now = nextAt
      const task = this.tasks.get(nextId)!
      this.tasks.delete(nextId)
      task.callback()
      for (let i = 0; i < 20; i++) await Promise.resolve()
    }
    this.now = target
  }
}

function makeWatchEnv(initialTurnCount: number, scrollTop = 4000): {
  clock: FakeClock
  scroller: FakeScroller
  turnCount(): number
  setTurnCount(value: number): void
  confirmed: { count: number }
  create(): ReturnType<typeof createPassiveTopWatch>
} {
  const clock = new FakeClock()
  const scroller = makeScroller(scrollTop)
  let count = initialTurnCount
  const confirmed = { count: 0 }
  const create = () =>
    createPassiveTopWatch({
      getContainer: () => scroller.el,
      getTurnCount: () => count,
      onTopConfirmed: () => {
        confirmed.count++
      },
      timers: clock.timers()
    })
  return {
    clock,
    scroller,
    turnCount: () => count,
    setTurnCount: (value: number) => {
      count = value
    },
    confirmed,
    create
  }
}

test('passiveTopWatch: 用户自然到顶且稳定 → 确认一次并自停（全程零滚动写入）', async () => {
  const env = makeWatchEnv(12)
  const watch = env.create()
  watch.watch()
  assert.equal(env.scroller.listenerCount(), 1)

  // 用户把页面滚到视觉顶部（测试模拟用户行为；watch 自身从未写 scrollTop）
  env.scroller.state.scrollTop = 0
  env.scroller.dispatchScroll()
  // 滚动静止去抖（500ms）+ 稳定窗口（1500ms）
  await env.clock.advance(2000)

  assert.equal(env.confirmed.count, 1)
  // 确认后自停：监听移除，后续滚动零工作
  assert.equal(env.scroller.listenerCount(), 0)
  env.scroller.state.scrollTop = 100
  env.scroller.dispatchScroll()
  await env.clock.advance(10_000)
  assert.equal(env.confirmed.count, 1)
})

test('passiveTopWatch: 稳定窗口内懒加载挂载新 turn → 重新武装，不抢跑', async () => {
  const env = makeWatchEnv(12)
  const watch = env.create()
  watch.watch()

  env.scroller.state.scrollTop = 0
  env.scroller.dispatchScroll()
  await env.clock.advance(500) // 静止 → 进入稳定窗口（快照 12）

  // 窗口中途懒加载挂载 8 个旧 turn（幂等模拟 ChatGPT 行为）
  await env.clock.advance(1000)
  env.setTurnCount(20)

  await env.clock.advance(1500) // 第一次窗口到期：计数已变 → 重新武装
  assert.equal(env.confirmed.count, 0, '懒加载仍在发生 → 不得确认到顶')

  await env.clock.advance(1500) // 第二个稳定窗口：计数不变 → 确认
  assert.equal(env.confirmed.count, 1)
})

test('passiveTopWatch: 用户离开顶部 → 放弃确认（位置优先于历史完整度）', async () => {
  const env = makeWatchEnv(12)
  const watch = env.create()
  watch.watch()

  env.scroller.state.scrollTop = 0
  env.scroller.dispatchScroll()
  await env.clock.advance(500)

  // 稳定窗口内用户滚回中部
  env.scroller.state.scrollTop = 2500
  env.scroller.dispatchScroll()
  await env.clock.advance(30_000)

  assert.equal(env.confirmed.count, 0)
})

test('passiveTopWatch: 未到顶的滚动只触发去抖检查，零确认零定时驻留', async () => {
  const env = makeWatchEnv(12, 2500)
  const watch = env.create()
  watch.watch()

  env.scroller.dispatchScroll()
  await env.clock.advance(5000)
  assert.equal(env.confirmed.count, 0)
})

test('passiveTopWatch: watch 前提是容器存在；stop 解绑并取消待决确认', async () => {
  const env = makeWatchEnv(12)
  const watch = env.create()
  // 容器不存在（root 未就绪）→ no-op
  const empty = createPassiveTopWatch({
    getContainer: () => null,
    getTurnCount: () => 0,
    onTopConfirmed: () => undefined,
    timers: env.clock.timers()
  })
  empty.watch()

  watch.watch()
  env.scroller.state.scrollTop = 0
  env.scroller.dispatchScroll()
  // 确认前路由切换 → stop 必须连稳定窗口一起取消
  await env.clock.advance(600)
  watch.stop()
  await env.clock.advance(10_000)
  assert.equal(env.confirmed.count, 0)
  assert.equal(env.scroller.listenerCount(), 0)
})

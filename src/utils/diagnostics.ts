import type { ChatProvider } from '../providers/types'
import type { ConversationStore } from '../conversation/store'
import type { ConversationCacheStore } from '../cache/cacheStore'
import type { HistoryWarmupSnapshot } from '../conversation/historyWarmup'
import { getScrollBounds, isAtVisualBottom, isAtVisualTop, isReversedContainer } from '../navigation/scrollGeometry'
import type { PerformanceSnapshot } from './performance'

/**
 * 隐私安全诊断导出（v1.2.1）：
 * 供用户在报 bug 时提供 `__tn.copyDiagnostics()` 输出。
 *
 * 只允许元数据（版本 / 计数 / 布尔 / 耗时）；绝不包含：
 * 用户 prompt、assistant 正文、会话标题、turn 标题 / preview、
 * 会话 UUID、消息 ID、DOM HTML、含会话 ID 的 URL。
 * 由 test/unit/diagnostics.test.ts 以合同方式强制。
 */

export interface TurnRailDiagnosticsContext {
  /** 扩展版本（chrome.runtime.getManifest().version） */
  version: string
  provider: ChatProvider
  store: ConversationStore
  cache: ConversationCacheStore
  /** 当前性能快照（非 DEBUG 为 null） */
  performance: PerformanceSnapshot | null
  /** rail marker 数量（Shadow DOM 内，UI 自行统计） */
  markers: () => number
  /** 当前会话 checkpoint 数（Handoff 元数据，不含任何正文） */
  checkpointCount?: number
  /** pending handoff 元数据（纯数字；payload 绝不出现在诊断中） */
  handoff?: {
    pending: boolean
    ageMs: number | null
    characters: number | null
  }
  /** 后台历史预热快照（纯数字 / 枚举，无正文无 turn ID，规格 #49） */
  historyWarmup?: HistoryWarmupSnapshot | null
}

export interface TurnRailDiagnostics {
  turnrailVersion: string
  timestamp: number

  provider: {
    name: string
    strategy: string
    conversationRoot: boolean
    scrollContainer: boolean
    turnRoots: number
    userUnits: number
    assistantUnits: number
  }

  /** 路由状态（会话 ID 只报存在性，绝不输出 UUID 本身） */
  route: {
    isConversationRoute: boolean
    conversationIdPresent: boolean
  }

  navigation: {
    storeTurns: number
    mountedTurns: number
    detachedTurns: number
    markers: number
  }

  scroll: {
    flexDirection: string | null
    reversed: boolean | null
    scrollTop: number | null
    scrollExtent: number | null
    atVisualTop: boolean | null
    atVisualBottom: boolean | null
  }

  performance: PerformanceSnapshot | null

  /** 缓存指标（白名单字段；provider / conversationId 明确排除） */
  cache: {
    available: boolean
    hit: boolean | null
    cachedTurns: number | null
    complete: boolean | null
    pinned: boolean | null
    readMs: number | null
    writeMs: number | null
  }

  /** Handoff 元数据（白名单；绝不含 handoff 文本 / checkpoint 正文 / 会话 ID） */
  handoff: {
    checkpointCount: number
    pending: boolean
    ageMs: number | null
    characters: number | null
  }

  /** 后台历史预热（白名单：状态枚举 + 纯数字；无标题 / preview / turn ID） */
  historyWarmup: {
    state: string
    batches: number
    steps: number
    indexedTurns: number
    previewTurns: number
    reachedTop: boolean
    pauseReason: string | null
  } | null
}

export function buildDiagnostics(ctx: TurnRailDiagnosticsContext): TurnRailDiagnostics {
  const providerHealth = ctx.provider.getDiagnostics()
  const sc = ctx.provider.getScrollContainer()
  const bounds = sc ? getScrollBounds(sc) : null
  const cacheStats = ctx.cache.getStats()
  const performance = ctx.performance

  return {
    turnrailVersion: ctx.version,
    timestamp: Date.now(),

    provider: {
      name: ctx.provider.name,
      strategy: providerHealth.strategy,
      conversationRoot: providerHealth.conversationRoot,
      scrollContainer: providerHealth.scrollContainer,
      turnRoots: providerHealth.turnRoots,
      userUnits: providerHealth.userUnits,
      assistantUnits: providerHealth.assistantUnits
    },

    route: {
      isConversationRoute: ctx.provider.isConversationRoute(),
      conversationIdPresent: ctx.provider.getConversationId() !== null
    },

    navigation: {
      storeTurns: ctx.store.turns.length,
      mountedTurns: ctx.store.turns.filter((turn) =>
        Boolean((turn.user?.element ?? turn.assistant?.element)?.isConnected)
      ).length,
      detachedTurns: ctx.store.detached.length,
      markers: ctx.markers()
    },

    scroll: {
      flexDirection: sc ? window.getComputedStyle(sc).flexDirection : null,
      reversed: sc ? isReversedContainer(sc) : null,
      scrollTop: sc ? sc.scrollTop : null,
      scrollExtent: bounds?.extent ?? null,
      atVisualTop: sc ? isAtVisualTop(sc) : null,
      atVisualBottom: sc ? isAtVisualBottom(sc) : null
    },

    performance,

    cache: {
      available: cacheStats.available,
      hit: cacheStats.hit,
      cachedTurns: cacheStats.cachedTurns,
      complete: cacheStats.complete,
      pinned: cacheStats.pinned,
      readMs: cacheStats.readMs,
      writeMs: cacheStats.lastWriteMs
    },

    handoff: {
      checkpointCount: ctx.checkpointCount ?? 0,
      pending: ctx.handoff?.pending ?? false,
      ageMs: ctx.handoff?.ageMs ?? null,
      characters: ctx.handoff?.characters ?? null
    },

    historyWarmup: ctx.historyWarmup
      ? {
          state: ctx.historyWarmup.state,
          batches: ctx.historyWarmup.batches,
          steps: ctx.historyWarmup.steps,
          indexedTurns: ctx.historyWarmup.fullUserTurns + ctx.historyWarmup.previewUserTurns,
          previewTurns: ctx.historyWarmup.previewUserTurns,
          reachedTop: ctx.historyWarmup.reachedTop,
          pauseReason: ctx.historyWarmup.pausedReason
        }
      : null
  }
}

import { DEBUG } from './logger.ts'

/**
 * 性能统计（仅 DEBUG = tn-debug=1 时启用）。
 * 生产（DEBUG=false）下所有方法为空操作、快照为 null，零额外开销。
 * 只统计计数与耗时，绝不含聊天正文；不上传任何数据。
 */

export interface StartupStats {
  bootstrapStart: number
  uiMountedMs?: number
  cacheReadMs?: number
  cacheHydrateMs?: number
  rootDetectedMs?: number
  firstLiveScanMs?: number
  firstRailVisibleMs?: number
  /** TTLR：第一次 Live DOM reconcile 完成距 bootstrap 开始 */
  firstLiveReconcileMs?: number
}

export interface IndexerStats {
  fullScans: number
  incrementalScans: number
  parsedTurns: number
  skippedTurns: number
  lastScanMs: number
  totalScanMs: number
  fallbackFullScans: number
}

export interface ObserverStats {
  callbacks: number
  mutationRecords: number
  relevantMutations: number
  ignoredMutations: number
  newTurn: number
  turnStructure: number
  assistantStreamIgnored: number
  irrelevantIgnored: number
  unknownFallback: number
}

export interface RenderStats {
  railFullRenders: number
  railIncrementalUpdates: number
  outlineFullRenders: number
  outlineSkippedRenders: number
}

/** 健康分析执行计数（纯数字指标，验证 assistant 流式期间不重复分析） */
export interface HealthStats {
  analyzes: number
}

export interface PerformanceSnapshot {
  startup: StartupStats
  indexer: IndexerStats
  observer: ObserverStats
  render: RenderStats
  health: HealthStats
}

class PerformanceStats {
  readonly startup: StartupStats = { bootstrapStart: 0 }
  readonly indexer: IndexerStats = {
    fullScans: 0,
    incrementalScans: 0,
    parsedTurns: 0,
    skippedTurns: 0,
    lastScanMs: 0,
    totalScanMs: 0,
    fallbackFullScans: 0
  }
  readonly observer: ObserverStats = {
    callbacks: 0,
    mutationRecords: 0,
    relevantMutations: 0,
    ignoredMutations: 0,
    newTurn: 0,
    turnStructure: 0,
    assistantStreamIgnored: 0,
    irrelevantIgnored: 0,
    unknownFallback: 0
  }
  readonly render: RenderStats = {
    railFullRenders: 0,
    railIncrementalUpdates: 0,
    outlineFullRenders: 0,
    outlineSkippedRenders: 0
  }
  readonly health: HealthStats = { analyzes: 0 }

  reset(): void {
    this.startup.bootstrapStart = performance.now()
    this.startup.uiMountedMs = undefined
    this.startup.cacheReadMs = undefined
    this.startup.cacheHydrateMs = undefined
    this.startup.rootDetectedMs = undefined
    this.startup.firstLiveScanMs = undefined
    this.startup.firstRailVisibleMs = undefined
    this.startup.firstLiveReconcileMs = undefined
    Object.assign(this.indexer, {
      fullScans: 0, incrementalScans: 0, parsedTurns: 0, skippedTurns: 0,
      lastScanMs: 0, totalScanMs: 0, fallbackFullScans: 0
    })
    Object.assign(this.observer, {
      callbacks: 0, mutationRecords: 0, relevantMutations: 0, ignoredMutations: 0,
      newTurn: 0, turnStructure: 0, assistantStreamIgnored: 0,
      irrelevantIgnored: 0, unknownFallback: 0
    })
    Object.assign(this.render, {
      railFullRenders: 0, railIncrementalUpdates: 0,
      outlineFullRenders: 0, outlineSkippedRenders: 0
    })
    this.health.analyzes = 0
  }

  snapshot(): PerformanceSnapshot {
    return {
      startup: { ...this.startup },
      indexer: { ...this.indexer },
      observer: { ...this.observer },
      render: { ...this.render },
      health: { ...this.health }
    }
  }
}

/** DEBUG 关闭时的空实现：方法 no-op，snapshot 返回 null */
interface StatsCore {
  startup: StartupStats
  indexer: IndexerStats
  observer: ObserverStats
  render: RenderStats
  health: HealthStats
  reset(): void
  snapshot(): PerformanceSnapshot | null
}

class NoopPerformanceStats implements StatsCore {
  startup: StartupStats = { bootstrapStart: 0 }
  indexer: IndexerStats = {
    fullScans: 0, incrementalScans: 0, parsedTurns: 0, skippedTurns: 0,
    lastScanMs: 0, totalScanMs: 0, fallbackFullScans: 0
  }
  observer: ObserverStats = {
    callbacks: 0, mutationRecords: 0, relevantMutations: 0, ignoredMutations: 0,
    newTurn: 0, turnStructure: 0, assistantStreamIgnored: 0,
    irrelevantIgnored: 0, unknownFallback: 0
  }
  render: RenderStats = {
    railFullRenders: 0, railIncrementalUpdates: 0,
    outlineFullRenders: 0, outlineSkippedRenders: 0
  }
  health: HealthStats = { analyzes: 0 }
  reset(): void {}
  snapshot(): PerformanceSnapshot | null {
    return null
  }
}

function markOnce(current: number | undefined, value: number): number | undefined {
  return current === undefined ? value : current
}

export type TurnRailPerformanceStats = {
  startup: StartupStats
  /** 标记 UI mount 完成 */
  markUiMounted(): void
  /** 标记缓存读取耗时 */
  markCacheRead(ms: number): void
  /** 标记缓存 hydrate 耗时 */
  markCacheHydrate(ms: number): void
  /** 标记 conversation root 首次出现 */
  markRootDetected(): void
  /** 标记第一次 Live scan 完成 */
  markFirstLiveScan(): void
  /** 标记 rail 第一次可见（TTFR） */
  markFirstRailVisible(): void
  /** 标记第一次 Live reconcile 完成（TTLR） */
  markFirstLiveReconcile(): void
  /** 记录一次 full scan（含耗时；fallback 标记由错误恢复触发） */
  fullScan(ms: number, fallback?: boolean): void
  /** 记录一次增量 scan：parsed/skipped turn 数与耗时 */
  incrementalScan(ms: number, parsedTurns: number, skippedTurns: number): void
  /** 记录一次 observer 回调 */
  observerCallback(records: number, relevant: number, ignored: number): void
  /** 记录 mutation 分类计数 */
  classify(kind: 'newTurn' | 'turnStructure' | 'assistantStream' | 'irrelevant' | 'unknown', count: number): void
  railFull(): void
  railIncremental(): void
  outlineFull(): void
  outlineSkipped(): void
  /** 记录一次健康分析真正执行（含耗时不记录正文；验证流式期间不重复分析） */
  markHealthAnalyze(): void
  reset(): void
  snapshot(): PerformanceSnapshot | null
}

function createStats(enabled: boolean): TurnRailPerformanceStats {
  const stats: StatsCore = enabled ? new PerformanceStats() : new NoopPerformanceStats()
  return {
    startup: stats.startup,
    markUiMounted(): void {
      if (!enabled) return
      stats.startup.uiMountedMs = markOnce(stats.startup.uiMountedMs, performance.now() - stats.startup.bootstrapStart)
    },
    markCacheRead(ms): void {
      if (!enabled) return
      stats.startup.cacheReadMs = markOnce(stats.startup.cacheReadMs, ms)
    },
    markCacheHydrate(ms): void {
      if (!enabled) return
      stats.startup.cacheHydrateMs = markOnce(stats.startup.cacheHydrateMs, ms)
    },
    markRootDetected(): void {
      if (!enabled) return
      stats.startup.rootDetectedMs = markOnce(stats.startup.rootDetectedMs, performance.now() - stats.startup.bootstrapStart)
    },
    markFirstLiveScan(): void {
      if (!enabled) return
      stats.startup.firstLiveScanMs = markOnce(stats.startup.firstLiveScanMs, performance.now() - stats.startup.bootstrapStart)
    },
    markFirstRailVisible(): void {
      if (!enabled) return
      stats.startup.firstRailVisibleMs = markOnce(stats.startup.firstRailVisibleMs, performance.now() - stats.startup.bootstrapStart)
    },
    markFirstLiveReconcile(): void {
      if (!enabled) return
      stats.startup.firstLiveReconcileMs = markOnce(stats.startup.firstLiveReconcileMs, performance.now() - stats.startup.bootstrapStart)
    },
    fullScan(ms, fallback): void {
      if (!enabled) return
      stats.indexer.fullScans++
      if (fallback) stats.indexer.fallbackFullScans++
      stats.indexer.lastScanMs = ms
      stats.indexer.totalScanMs += ms
    },
    incrementalScan(ms, parsedTurns, skippedTurns): void {
      if (!enabled) return
      stats.indexer.incrementalScans++
      stats.indexer.parsedTurns += parsedTurns
      stats.indexer.skippedTurns += skippedTurns
      stats.indexer.lastScanMs = ms
      stats.indexer.totalScanMs += ms
    },
    observerCallback(records, relevant, ignored): void {
      if (!enabled) return
      stats.observer.callbacks++
      stats.observer.mutationRecords += records
      stats.observer.relevantMutations += relevant
      stats.observer.ignoredMutations += ignored
    },
    classify(kind, count): void {
      if (!enabled) return
      if (kind === 'newTurn') stats.observer.newTurn += count
      else if (kind === 'turnStructure') stats.observer.turnStructure += count
      else if (kind === 'assistantStream') stats.observer.assistantStreamIgnored += count
      else if (kind === 'irrelevant') stats.observer.irrelevantIgnored += count
      else stats.observer.unknownFallback += count
    },
    railFull(): void {
      if (!enabled) return
      stats.render.railFullRenders++
    },
    railIncremental(): void {
      if (!enabled) return
      stats.render.railIncrementalUpdates++
    },
    outlineFull(): void {
      if (!enabled) return
      stats.render.outlineFullRenders++
    },
    outlineSkipped(): void {
      if (!enabled) return
      stats.render.outlineSkippedRenders++
    },
    markHealthAnalyze(): void {
      if (!enabled) return
      stats.health.analyzes++
    },
    reset(): void {
      stats.reset()
    },
    snapshot(): PerformanceSnapshot | null {
      return stats.snapshot()
    }
  }
}

export const perf: TurnRailPerformanceStats = createStats(DEBUG)

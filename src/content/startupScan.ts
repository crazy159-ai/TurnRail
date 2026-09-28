/**
 * 启动稳定性重试（v1.2，替代固定 8×400ms 轮询）：
 * 指数退避 [100, 250, 500, 1000, 1600, 2400]ms；
 * root 已存在且连续 2 次 scan 签名不变 → 提前停止（#29-31、#69）；
 * root 不存在时继续等待（不计稳定）。此后交给 MutationObserver，不做常态轮询（#32）。
 */

export interface ScanSignature {
  turnCount: number
  lastTurnId?: string
}

export interface StartupScanOptions {
  /** 执行一次扫描并返回当前签名；返回 null 表示本轮不计稳定（如路由已切换） */
  scan: () => ScanSignature | null
  /** conversation root 是否已存在；不存在时本轮不计稳定 */
  hasRoot?: () => boolean
  /** 退避间隔表 */
  delays?: number[]
  onSettled?: () => void
}

export const DEFAULT_STARTUP_DELAYS = [100, 250, 500, 1000, 1600, 2400]

export function startStartupScan(options: StartupScanOptions): () => void {
  const delays = options.delays ?? DEFAULT_STARTUP_DELAYS
  let timer: ReturnType<typeof setTimeout> | undefined
  let index = 0
  let previous: ScanSignature | null = null
  let stableRounds = 0
  let stopped = false

  const finish = (): void => {
    stopped = true
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    options.onSettled?.()
  }

  const step = (): void => {
    if (stopped) return
    const signature = options.scan()
    if (signature && (!options.hasRoot || options.hasRoot())) {
      if (
        previous !== null &&
        previous.turnCount === signature.turnCount &&
        previous.lastTurnId === signature.lastTurnId
      ) {
        stableRounds++
      } else {
        stableRounds = 0
      }
      previous = signature
      if (stableRounds >= 2) {
        finish()
        return
      }
    }
    if (index >= delays.length) {
      finish()
      return
    }
    timer = setTimeout(step, delays[index++]!)
  }

  timer = setTimeout(step, delays[index++]!)
  return () => {
    finish()
  }
}

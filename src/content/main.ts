import { bootstrap } from './bootstrap'
import { HOST_ID } from '../ui/createShadowRoot'

/**
 * content script 入口：
 * - 防重复注入（host 元素 + 全局 Symbol 双保险）；
 * - DOM 未就绪时等待 DOMContentLoaded。
 */
const INSTALL_GUARD = Symbol.for('turnrail.installed')
const globals = globalThis as unknown as Record<symbol, unknown>

function start(): void {
  if (document.getElementById(HOST_ID)) return
  try {
    bootstrap()
  } catch (err) {
    console.warn('[TurnRail] 初始化失败（不影响页面使用）', err)
  }
}

if (!globals[INSTALL_GUARD] && !document.getElementById(HOST_ID)) {
  globals[INSTALL_GUARD] = true
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true })
  } else {
    start()
  }
}

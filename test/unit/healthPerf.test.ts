import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeConversationHealth } from '../../src/health/analyzer.ts'
import type { ConversationTurn } from '../../src/conversation/types.ts'

/**
 * 性能防退化合同（§56）：分析复杂度必须保持 O(n + k²)（k ≤ 12 窗口）。
 * 门槛刻意宽松（实测约 0.1ms / 1000 轮，50ms 有数百倍余量），
 * 目的只是防止未来误引入全历史两两比较等 O(n²) 路径。
 */

function makeTurns(n: number): ConversationTurn[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `t${i}`,
    index: i,
    user: {
      id: `u${i}`,
      role: 'user' as const,
      text:
        i % 7 === 0
          ? '不对，重新做这一段，改成异步方案。'
          : `继续完善解析器模块第 ${i} 步，保持接口兼容，参考 module-${i}.ts 的实现并补充测试用例。`,
      turnIndex: i,
      firstSeenAt: i,
      isMounted: false
    },
    assistant: {
      id: `a${i}`,
      role: 'assistant' as const,
      text: '好的，这是长回答。'.repeat(200),
      turnIndex: i,
      firstSeenAt: i,
      isMounted: false
    },
    title: `第 ${i} 轮`,
    preview: ''
  }))
}

for (const size of [100, 300, 500, 1000]) {
  test(`perf: analyzeConversationHealth ${size} turns`, () => {
    const turns = makeTurns(size)
    analyzeConversationHealth(turns) // 预热（JIT / 内联缓存）

    const start = performance.now()
    const snapshot = analyzeConversationHealth(turns)
    const elapsed = performance.now() - start

    console.log(`    health analyze ${String(size).padStart(4)} turns: ${elapsed.toFixed(3)}ms`)
    assert.ok(snapshot.score >= 0 && snapshot.score <= 100)
    if (size === 1000) {
      assert.ok(elapsed < 50, `1000 轮分析耗时 ${elapsed.toFixed(2)}ms 超过 50ms 门槛（疑似 O(n²) 退化）`)
    }
  })
}

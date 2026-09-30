import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeConversationHealth } from '../../src/health/analyzer.ts'
import type { ConversationTurn } from '../../src/conversation/types.ts'
import type { ConversationHealthSnapshot } from '../../src/health/types.ts'
import { HEALTH_CASES } from './healthCases.ts'

function makeTurns(
  prompts: string[],
  completeness?: 'full' | 'preview',
  assistants?: string[]
): ConversationTurn[] {
  return prompts.map((text, index) => ({
    id: `turn-${index}`,
    index,
    user: {
      id: `user-${index}`,
      role: 'user',
      text,
      turnIndex: index,
      firstSeenAt: index,
      isMounted: false,
      contentCompleteness: completeness
    },
    assistant: {
      id: `assistant-${index}`,
      role: 'assistant',
      text: assistants?.[index] ?? '已处理。',
      turnIndex: index,
      firstSeenAt: index,
      isMounted: false
    },
    title: text.slice(0, 60),
    preview: text.slice(0, 160)
  }))
}

function analyzeCase(kase: (typeof HEALTH_CASES)[number]): ConversationHealthSnapshot {
  return analyzeConversationHealth(makeTurns(kase.prompts, kase.completeness, kase.assistants))
}

/** P2-2：Golden Cases —— 真实形态对话的分数区间 + 允许等级合同 */
for (const kase of HEALTH_CASES) {
  test(`golden: ${kase.name}`, () => {
    const snapshot = analyzeCase(kase)
    const { scoreMin, scoreMax, allowedLevels, assert: extra } = kase.expected
    if (scoreMin !== undefined) {
      assert.ok(snapshot.score >= scoreMin, `${kase.name}: 分数 ${snapshot.score} < 下限 ${scoreMin}`)
    }
    if (scoreMax !== undefined) {
      assert.ok(snapshot.score <= scoreMax, `${kase.name}: 分数 ${snapshot.score} > 上限 ${scoreMax}`)
    }
    assert.ok(
      allowedLevels.includes(snapshot.level),
      `${kase.name}: 等级 ${snapshot.level} 不在允许集合 [${allowedLevels.join(', ')}]（分数 ${snapshot.score}）`
    )
    extra?.(snapshot)
  })
}

// ---------- Coverage / Confidence（#59 Tests C/D/E/F） ----------

test('coverage: 纯 cache preview → confidence low + source cache-preview', () => {
  const snapshot = analyzeConversationHealth(makeTurns(Array.from({ length: 12 }, (_, i) => `问题 ${i}`), 'preview'))
  assert.equal(snapshot.confidence, 'low')
  assert.equal(snapshot.coverage.source, 'cache-preview')
  assert.equal(snapshot.coverage.previewOnlyTurns, 12)
  assert.equal(snapshot.coverage.coverageRatio, 0)
})

test('coverage: 50% live + 50% preview → confidence medium + source mixed', () => {
  const turns = makeTurns(Array.from({ length: 20 }, (_, i) => `问题 ${i}`), 'preview')
  // 前 10 个 turn 升级为 live（模拟 Live reconcile 已覆盖一半）
  for (let i = 0; i < 10; i++) turns[i]!.user!.contentCompleteness = 'full'
  const snapshot = analyzeConversationHealth(turns)
  assert.equal(snapshot.confidence, 'medium')
  assert.equal(snapshot.coverage.source, 'mixed')
  assert.equal(snapshot.coverage.coverageRatio, 0.5)
})

test('coverage: 几乎全 live → confidence high', () => {
  const turns = makeTurns(Array.from({ length: 20 }, (_, i) => `问题 ${i}`), 'preview')
  for (let i = 0; i < 19; i++) turns[i]!.user!.contentCompleteness = 'full'
  const snapshot = analyzeConversationHealth(turns)
  assert.equal(snapshot.confidence, 'high')
  assert.equal(snapshot.coverage.source, 'mixed')
})

test('coverage: 全 live → confidence high + source live', () => {
  const snapshot = analyzeConversationHealth(makeTurns(Array.from({ length: 12 }, (_, i) => `问题 ${i}`)))
  assert.equal(snapshot.confidence, 'high')
  assert.equal(snapshot.coverage.source, 'live')
})

/** #59 Test F / #32：分数落入 new-chat 区间但置信度 low → 必须被降级，不得强建议换聊 */
test('guardrail: score 低 + confidence low → 不进入 new-chat', () => {
  const longPreviewPrompts = Array.from(
    { length: 80 },
    (_, i) =>
      `继续第 ${i + 1} 步。${'上下文'.repeat(200)}${
        i >= 68 ? '不对，重新做。还是不对，纠正一下，基于之前的结论重来。' : ''
      }`
  )
  const snapshot = analyzeConversationHealth(makeTurns(longPreviewPrompts, 'preview'))

  assert.equal(snapshot.confidence, 'low')
  assert.ok(snapshot.score < 45, `多重风险叠加的 preview 对话分数应落入换聊区间，实际 ${snapshot.score}`)
  assert.equal(
    snapshot.level,
    'watch',
    '证据只来自缓存 preview 时，即使分数很低也必须降级为 watch（覆盖不足）'
  )
})

// ---------- 重复放大器（P1-4 / Tests I/J） ----------

test('amplifier: 高重复稳定开发 → risk 不明显恶化（不进入 organize）', () => {
  const prompts = Array.from(
    { length: 20 },
    (_, i) => `继续完善 TurnRail parser，保持 Provider boundary，补充 parser 单测（第 ${i + 1} 组）。`
  )
  const snapshot = analyzeConversationHealth(makeTurns(prompts))

  assert.ok(snapshot.evidence.repeatedPromptPairs > 0, '同模板迭代应检出重复')
  assert.ok(snapshot.score >= 65, `稳定迭代不应因重复被压到 organize 以下，实际 ${snapshot.score}`)
  assert.notEqual(snapshot.level, 'organize')
  assert.notEqual(snapshot.level, 'new-chat')
})

test('amplifier: 高重复 + 高频纠错 → 比单纯高重复风险更高', () => {
  const stable = Array.from(
    { length: 14 },
    (_, i) => `继续完善 TurnRail parser，保持 Provider boundary，补充 parser 单测（第 ${i + 1} 组）。`
  )
  const friction = Array.from({ length: 14 }, () => '不对，重新做。')

  const stableSnapshot = analyzeConversationHealth(makeTurns(stable))
  const frictionSnapshot = analyzeConversationHealth(makeTurns(friction))

  assert.ok(frictionSnapshot.score < stableSnapshot.score, '重复叠加纠错应比纯稳定迭代风险更高')
})

// ---------- 中文主题漂移（P1-6 / Tests K/L） ----------

test('topic: 中文主题突变（扩展 → 桥梁 PINN）显著升高', () => {
  const chrome = Array.from(
    { length: 15 },
    (_, i) =>
      `浏览器扩展的 content script 用 MutationObserver 监听对话节点，索引器重建轨道标记，选择器回退策略第 ${i} 部分。`
  )
  const pinn = Array.from(
    { length: 5 },
    (_, i) => `物理信息神经网络求解桥梁动力学：模态分析、固有频率、偏微分方程残差，案例 ${i}。`
  )
  const drifted = analyzeConversationHealth(makeTurns([...chrome, ...pinn]))
  const stable = analyzeConversationHealth(makeTurns([...chrome, ...chrome.slice(-5)]))

  assert.ok(drifted.signals.topicDrift > 0.5, `中文换题应检出漂移，实际 ${drifted.signals.topicDrift}`)
  assert.ok(drifted.signals.topicDrift > stable.signals.topicDrift + 0.4)
})

test('topic: 中英文混合对话漂移检测正常（中文信号不因配额丢失）', () => {
  const mixed = Array.from(
    { length: 15 },
    (_, i) => `继续 parser 重构，第 ${i} 步：mutation observer 的 DOM 兼容层与缓存策略。`
  )
  const recent = Array.from(
    { length: 5 },
    (_, i) => `桥梁动力学模态分析，固有频率与 PINN 训练策略，第 ${i} 讲。`
  )
  const snapshot = analyzeConversationHealth(makeTurns([...mixed, ...recent]))
  assert.ok(
    snapshot.signals.topicDrift > 0.4,
    `中文主题在混合对话中仍应被检出，实际 ${snapshot.signals.topicDrift}`
  )
})

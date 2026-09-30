import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeConversationHealth, HEALTH_WEIGHTS } from '../../src/health/analyzer.ts'
import type { ConversationTurn } from '../../src/conversation/types.ts'

function makeTurns(
  prompts: string[],
  assistants: string[] = [],
  completeness?: 'full' | 'preview'
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
      text: assistants[index] ?? '已处理。',
      turnIndex: index,
      firstSeenAt: index,
      isMounted: false
    },
    title: text.slice(0, 60),
    preview: text.slice(0, 160)
  }))
}

test('health: 短而稳定的对话保持 healthy', () => {
  const snapshot = analyzeConversationHealth(
    makeTurns([
      '解释 TypeScript 中的泛型。',
      '再解释约束 extends 的作用。',
      '给一个 Map 泛型的例子。',
      '这个例子如何增加 readonly？'
    ])
  )

  assert.equal(snapshot.basis, 'indexed-local-heuristic')
  assert.ok(snapshot.score >= 80)
  assert.equal(snapshot.level, 'healthy')
})

test('health: 轮数不是单独的换聊阈值', () => {
  const prompts = Array.from(
    { length: 80 },
    (_, i) => `继续完善同一个解析器模块，第 ${i + 1} 步保持接口兼容并补充测试。`
  )
  const snapshot = analyzeConversationHealth(makeTurns(prompts))

  assert.ok(snapshot.evidence.turnCount === 80)
  assert.ok(snapshot.signals.lengthPressure > 0)
  assert.ok(snapshot.score >= 65, `稳定长对话不应仅因 80 轮被强制判定换聊，实际分数 ${snapshot.score}`)
  assert.notEqual(snapshot.level, 'new-chat')
})

test('health: 长度 + 纠错 + 方案反转 + 跨轮依赖叠加时建议新开聊天', () => {
  const prompts = Array.from({ length: 82 }, (_, i) => {
    const correction = i % 2 === 0 ? '前面理解错了，重新做并修正。' : '还是不对，请纠正。'
    const churn = i % 3 === 0 ? '不要用之前方案，改成新的实现并撤销前面的决定。' : '现在改为另一种方案。'
    const reference = '继续基于之前和上面的所有结论，同时保持前几轮约束。'
    const file = `请结合 module-${i}.ts、notes-${i}.md 与已有代码块。`
    return `${correction}${churn}${reference}${file}` + 'x'.repeat(2600)
  })

  const snapshot = analyzeConversationHealth(makeTurns(prompts))

  assert.ok(snapshot.signals.lengthPressure > 0.7)
  assert.ok(snapshot.signals.correctionFrequency > 0.7)
  assert.ok(snapshot.signals.decisionChurn > 0.7)
  assert.ok(snapshot.signals.referenceDependency > 0.5)
  assert.ok(snapshot.score < 45, `高风险叠加场景应进入 new-chat，实际分数 ${snapshot.score}`)
  assert.equal(snapshot.level, 'new-chat')
  assert.match(snapshot.recommendation, /新开聊天/)
})

test('health: 输出原因不回显 prompt 正文', () => {
  const secret = 'SECRET-PROMPT-银行卡-6222000011112222'
  const prompts = Array.from(
    { length: 30 },
    (_, i) => `前面不对，重新做，改成方案 B，继续之前的内容。${secret}-${i}`
  )
  const snapshot = analyzeConversationHealth(makeTurns(prompts))
  const json = JSON.stringify(snapshot.reasons)

  assert.ok(!json.includes(secret))
  assert.ok(snapshot.reasons.length <= 3)
})

// ---------- 权重合同（§ 权重集中管理） ----------

test('health: 权重和为 1，且各项均在 (0,1) 内', () => {
  const entries = Object.entries(HEALTH_WEIGHTS)
  assert.equal(entries.length, 6)
  const sum = entries.reduce((sum, [, weight]) => sum + weight, 0)
  assert.ok(Math.abs(sum - 1) < 1e-9, `权重和应为 1，实际 ${sum}`)
  for (const [name, weight] of entries) {
    assert.ok(weight > 0 && weight < 1, `${name} 权重应在 (0,1) 内`)
  }
})

// ---------- 单信号专项（提示词 Tests 3-6） ----------

/** 与被测场景同规模的中性基线：无纠错 / 无反转 / 无指代 */
function neutralPrompts(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `继续完善解析器第 ${i + 1} 个函数，保持接口兼容并同步更新注释。`)
}

test('health: 纠错频繁时 correctionFrequency 明显升高', () => {
  const baseline = analyzeConversationHealth(makeTurns(neutralPrompts(14)))
  const prompts = neutralPrompts(2).concat(
    Array.from({ length: 12 }, (_, i) =>
      i % 3 === 0 ? '不对，理解错了，请重新做这一段。' : '还是不对，输出和第 3 轮的要求矛盾，纠正一下。'
    )
  )
  const snapshot = analyzeConversationHealth(makeTurns(prompts))

  assert.ok(
    snapshot.signals.correctionFrequency > 0.8,
    `最近窗口高密度纠错应接近 1，实际 ${snapshot.signals.correctionFrequency}`
  )
  assert.ok(snapshot.signals.correctionFrequency > baseline.signals.correctionFrequency + 0.5)
  // 纠错话题词不应被误判："错误处理"是任务词汇，不是对模型的纠正
  const topicTurns = analyzeConversationHealth(
    makeTurns(Array.from({ length: 14 }, (_, i) => `讨论错误处理与重试机制的几种设计，第 ${i + 1} 部分。`))
  )
  assert.ok(topicTurns.signals.correctionFrequency < 0.3)
})

test('health: 方案反转频繁时 decisionChurn 明显升高', () => {
  const baseline = analyzeConversationHealth(makeTurns(neutralPrompts(14)))
  const prompts = neutralPrompts(2).concat(
    Array.from(
      { length: 12 },
      (_, i) =>
        i % 2 === 0
          ? '不要用之前的方案了，改成事件总线，撤销前面关于单例的决定。'
          : '再换成存储抽象层，架构上改为依赖注入的方式。'
    )
  )
  const snapshot = analyzeConversationHealth(makeTurns(prompts))

  assert.ok(snapshot.signals.decisionChurn > 0.8, `反转高密度应接近 1，实际 ${snapshot.signals.decisionChurn}`)
  assert.ok(snapshot.signals.decisionChurn > baseline.signals.decisionChurn + 0.5)
})

test('health: 跨轮指代密集时 referenceDependency 升高', () => {
  const baseline = analyzeConversationHealth(makeTurns(neutralPrompts(16)))
  const prompts = neutralPrompts(4).concat(
    Array.from(
      { length: 12 },
      (_, i) =>
        `基于之前第 ${i} 轮的结论，沿用前面确定的目录结构，结合上一轮与上文的约束继续推进。`
    )
  )
  const snapshot = analyzeConversationHealth(makeTurns(prompts))

  assert.ok(
    snapshot.signals.referenceDependency > baseline.signals.referenceDependency + 0.2,
    `跨轮指代应抬升依赖信号，实际 ${snapshot.signals.referenceDependency}`
  )
})

test('health: 主题漂移（Chrome 扩展 → PINN 桥梁）时 topicDrift 升高', () => {
  const chrome = Array.from(
    { length: 15 },
    (_, i) =>
      `chrome extension content script: the MutationObserver watches DOM turn nodes, indexer rebuilds rail markers, selector fallback part ${i}.`
  )
  const pinn = Array.from(
    { length: 5 },
    (_, i) =>
      `physics informed neural network for bridge dynamics: modal analysis, natural frequency, PINN loss for the PDE residual, case ${i}.`
  )
  const drifted = analyzeConversationHealth(makeTurns([...chrome, ...pinn]))
  const stable = analyzeConversationHealth(makeTurns([...chrome, ...chrome.slice(-5)]))

  assert.ok(drifted.signals.topicDrift > 0.5, `换题后漂移信号应显著升高，实际 ${drifted.signals.topicDrift}`)
  assert.ok(drifted.signals.topicDrift > stable.signals.topicDrift + 0.4)
})

// ---------- 单信号保护（§ 不因单一指标进入 new-chat） ----------

test('health: 只有单一信号极端升高时不得进入 new-chat', () => {
  // 最近 12 轮全部是纠错表达，但对话短、无长度压力、无其他信号
  const prompts = neutralPrompts(2).concat(
    Array.from({ length: 12 }, () => '不对，重新做。')
  )
  const snapshot = analyzeConversationHealth(makeTurns(prompts))

  assert.ok(snapshot.signals.correctionFrequency > 0.8)
  // P1-5 guardrail：强纠错信号必须至少 watch（加权分数会把单信号稀释到 healthy 区间）
  assert.equal(snapshot.level, 'watch')
})

/** P0-1 合同：assistant 正文长度绝不影响健康分（流式期间分数输入必须稳定） */
test('health: assistant 正文不参与评分（user-only）', () => {
  const prompts = neutralPrompts(20)
  const compact = analyzeConversationHealth(makeTurns(prompts, Array.from({ length: 20 }, () => '好的。')))
  const verbose = analyzeConversationHealth(
    makeTurns(prompts, Array.from({ length: 20 }, () => '很长的回答。'.repeat(2000)))
  )

  assert.equal(compact.score, verbose.score)
  assert.deepEqual(compact.signals, verbose.signals)
  assert.equal(compact.evidence.indexedUserCharacters, verbose.evidence.indexedUserCharacters)
})

/** Test H：正常 UI 微调（弱修改动词、无决策上下文）不得产生高 churn */
test('health: 普通参数修改不算方案反转', () => {
  const prompts = neutralPrompts(2).concat([
    '把按钮改成绿色。',
    '把 padding 改成 8px。',
    '把 README 标题改成英文。',
    '把变量名改成 healthScore。',
    '把默认端口切换到 8931。',
    '把提示文案改为更简短的版本。',
    '把图标换成 16px 的版本。',
    '把这个函数改成 async 的写法。',
    '把颜色改为深色主题变量。',
    '把 margin 改为 4px。',
    '把超链接改为新窗口打开。',
    '把日志改成 debug 级别。'
  ])
  const snapshot = analyzeConversationHealth(makeTurns(prompts))

  assert.ok(
    snapshot.signals.decisionChurn < 0.2,
    `普通修改不应计为方案反转，实际 ${snapshot.signals.decisionChurn}`
  )
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeConversationHealth } from '../../src/health/analyzer.ts'
import type { ConversationTurn } from '../../src/conversation/types.ts'

function makeTurns(prompts: string[], assistants: string[] = []): ConversationTurn[] {
  return prompts.map((text, index) => ({
    id: `turn-${index}`,
    index,
    user: {
      id: `user-${index}`,
      role: 'user',
      text,
      turnIndex: index,
      firstSeenAt: index,
      isMounted: false
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

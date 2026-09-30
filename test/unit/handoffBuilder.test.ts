import test from 'node:test'
import assert from 'node:assert/strict'
import { buildConversationHandoff, truncateFenceSafe } from '../../src/handoff/builder.ts'
import { formatConversationHandoff } from '../../src/handoff/formatter.ts'
import { HANDOFF_LIMITS } from '../../src/handoff/types.ts'
import type { ConversationCheckpoint, HandoffTurnSnapshot } from '../../src/handoff/types.ts'

/**
 * Handoff Builder 测试矩阵（规格 #34 Test 6-14）：
 * 确定性选取（Checkpoint + Recent Tail + Current Objective）、去重、
 * 字符预算、fence 安全截断、preview 不伪装、无 id/UUID 泄漏。
 */

const CONV = 'conv-handoff'

function turn(
  index: number,
  userText: string,
  assistantText: string | null,
  extra: Partial<HandoffTurnSnapshot> = {}
): HandoffTurnSnapshot {
  return {
    id: `turn-${index}`,
    index,
    userText,
    assistantText,
    ...extra
  }
}

function checkpoint(turnIndex: number, extra: Partial<ConversationCheckpoint> = {}): ConversationCheckpoint {
  return {
    id: `chk-${turnIndex}`,
    conversationId: CONV,
    turnId: `turn-${turnIndex}`,
    turnIndex,
    createdAt: 0,
    kind: 'custom',
    status: 'active',
    ...extra
  }
}

function buildTurns(count: number): HandoffTurnSnapshot[] {
  return Array.from({ length: count }, (_, i) =>
    turn(i, `第 ${i + 1} 个问题：请继续完成任务的下一步。`, `这是第 ${i + 1} 轮的回答正文。`)
  )
}

// ---------- Test 6：无 checkpoint → Recent Tail + Current Objective ----------

test('builder: 无 checkpoint → Recent Tail + Current Objective 正常生成', () => {
  const turns = buildTurns(10)
  const handoff = buildConversationHandoff({ conversationId: CONV, turns, checkpoints: [] })
  const text = formatConversationHandoff(handoff)

  assert.equal(handoff.source.totalUserTurns, 10)
  assert.equal(handoff.source.checkpointCount, 0)
  // recent tail = maxRecentTurns 个 + objective 1 个
  assert.equal(handoff.sections.filter((s) => s.kind === 'recent').length, HANDOFF_LIMITS.maxRecentTurns)
  const objective = handoff.sections.find((s) => s.kind === 'objective')!
  assert.equal(objective.turnNumber, 10)
  assert.equal(objective.userText, '第 10 个问题：请继续完成任务的下一步。')
  assert.ok(text.includes('## Current Objective'))
  assert.ok(text.includes('## Recent Working Context'))
  // tail 不含 objective 轮（无重复）
  assert.equal(handoff.sections.some((s) => s.kind === 'recent' && s.turnNumber === 10), false)
})

// ---------- Test 7：checkpoint 永远优先 ----------

test('builder: checkpoint 全部入选且排序在前，早于 recent tail', () => {
  const turns = buildTurns(20)
  const handoff = buildConversationHandoff({
    conversationId: CONV,
    turns,
    checkpoints: [checkpoint(4), checkpoint(11)]
  })

  const kinds = handoff.sections.map((s) => s.kind)
  assert.deepEqual(kinds.filter((k) => k === 'checkpoint'), ['checkpoint', 'checkpoint'])
  // checkpoint 段落在 recent 之前
  const firstCheckpoint = kinds.indexOf('checkpoint')
  const firstRecent = kinds.indexOf('recent')
  assert.ok(firstCheckpoint < firstRecent)
  // tail 只包含未被 checkpoint 的 turn，且仍取最近 N 个
  const tailNumbers = handoff.sections.filter((s) => s.kind === 'recent').map((s) => s.turnNumber)
  assert.equal(tailNumbers.includes(5), false) // turn-4 是 checkpoint（编号 5）
  assert.equal(tailNumbers.includes(12), false) // turn-11 是 checkpoint（编号 12）
})

// ---------- Test 8：同一 turn 不重复进入 Checkpoint + Recent Tail ----------

test('builder: checkpoint 轮绝不重复出现在 recent tail', () => {
  const turns = buildTurns(30)
  const marked = [3, 10, 25]
  const handoff = buildConversationHandoff({
    conversationId: CONV,
    turns,
    checkpoints: marked.map((i) => checkpoint(i))
  })

  const seen = new Set<number>()
  for (const section of handoff.sections) {
    assert.equal(seen.has(section.turnNumber), false, `turn ${section.turnNumber} 重复进入 handoff`)
    seen.add(section.turnNumber)
  }
})

// ---------- Test 9：严格遵守字符预算 ----------

test('builder: 超大对话最终文本仍严格 ≤ maxCharacters', () => {
  const turns = Array.from({ length: 40 }, (_, i) =>
    turn(i, `问题 ${i}：${'很长的上下文描述。'.repeat(400)}`, `回答 ${i}：${'很长的回答正文。'.repeat(600)}`)
  )
  const handoff = buildConversationHandoff({
    conversationId: CONV,
    turns,
    checkpoints: [checkpoint(5), checkpoint(30)]
  })
  const text = formatConversationHandoff(handoff)
  assert.ok(text.length <= HANDOFF_LIMITS.maxCharacters, `实际 ${text.length} > ${HANDOFF_LIMITS.maxCharacters}`)
  // checkpoint 必须保留
  assert.ok(text.includes('问题 5'), 'checkpoint 轮被误删')
})

// ---------- Test 10：超限产生 warning ----------

test('builder: 预算裁剪必须产生 warning，绝不静默', () => {
  const turns = Array.from({ length: 40 }, (_, i) =>
    turn(i, `问题 ${i}：${'超长内容。'.repeat(500)}`, `回答 ${i}：${'超长回答。'.repeat(800)}`)
  )
  const handoff = buildConversationHandoff({
    conversationId: CONV,
    turns,
    checkpoints: [checkpoint(2)]
  })
  assert.ok(handoff.warnings.length > 0, '超限必须产生 warning')
  assert.ok(
    handoff.warnings.some((w) => /truncated|omitted/i.test(w)),
    `warning 应描述截断/省略，实际: ${handoff.warnings.join(' | ')}`
  )
})

// ---------- Test 11：fence 不因截断形成未闭合代码块 ----------

test('builder: fence 安全 —— 截断后代码块保持闭合', () => {
  // 单条消息内含多个代码块，超过单条限额
  const codeBody = '```\nline1\nline2\nline3\n```\n中间文字。\n```python\nprint(1)\nprint(2)\n```'
  const turns = [
    turn(0, '带代码块的问题', `回答开头。\n${codeBody}\n${codeBody}\n回答结尾。`),
    ...buildTurns(6).map((t) => ({ ...t, index: t.index + 1, id: `turn-${t.index + 1}` }))
  ]
  const handoff = buildConversationHandoff({
    conversationId: CONV,
    turns,
    checkpoints: [],
    limits: { maxSingleMessageCharacters: 200 }
  })
  const text = formatConversationHandoff(handoff)
  const fences = (text.match(/```/g) ?? []).length
  assert.equal(fences % 2, 0, `fence 数必须为偶数，实际 ${fences}`)
})

test('builder: truncateFenceSafe 截断时不引入失衡 fence（源内容失衡不归其修正）', () => {
  const samples = [
    'plain text without fences',
    '```\nunclosed block',
    '```js\nclosed()\n```',
    'a```b```c',
    '```\n one \n```middle``` \ntail'
  ]
  for (const sample of samples) {
    for (const max of [5, 12, 40, 400]) {
      const out = truncateFenceSafe(sample, max)
      if (out === sample) continue // 未截断：保持原样（不修正源内容自身的 fence 问题）
      const fences = (out.match(/```/g) ?? []).length
      assert.equal(fences % 2, 0, `fence 失衡: ${JSON.stringify(sample)} max=${max} → ${JSON.stringify(out)}`)
    }
  }
  // 不超长时原样返回
  assert.equal(truncateFenceSafe('short', 100), 'short')
  // 超长时引入截断标记且 fence 平衡
  const truncated = truncateFenceSafe('```\n' + 'x'.repeat(200), 50)
  assert.equal((truncated.match(/```/g) ?? []).length % 2, 0)
})

// ---------- Test 12：assistant 缺失仍能生成合法 handoff ----------

test('builder: 无 assistant 正文的 turn 仍生成合法结构', () => {
  const turns = [
    turn(0, '只有提问的轮次', null),
    turn(1, '第二个问题', null),
    turn(2, '最后的目标问题', '')
  ]
  const handoff = buildConversationHandoff({ conversationId: CONV, turns, checkpoints: [] })
  const text = formatConversationHandoff(handoff)
  assert.equal(handoff.sections.length, 3) // recent(2) + objective(1)
  assert.ok(text.includes('## Current Objective'))
  assert.ok(text.includes('最后的目标问题'))
  assert.equal(text.includes('#### Assistant'), false)
})

// ---------- Test 13：preview checkpoint 不能伪装成 full ----------

test('builder: preview checkpoint 显式标注 + warning，绝不冒充完整结论', () => {
  const turns = [
    turn(0, '关键结论轮', '这是截断的缓存预览……', {
      userCompleteness: 'full',
      assistantCompleteness: 'preview'
    }),
    ...buildTurns(8).map((t) => ({ ...t, index: t.index + 1, id: `turn-${t.index + 1}` }))
  ]
  const handoff = buildConversationHandoff({
    conversationId: CONV,
    turns,
    checkpoints: [checkpoint(0)]
  })
  const text = formatConversationHandoff(handoff)
  assert.ok(text.includes('preview only'), 'preview 内容必须显式标注')
  assert.ok(
    handoff.warnings.some((w) => /previews/i.test(w)),
    'preview checkpoint 必须产生 warning'
  )
})

// ---------- Test 14：不泄露 conversation UUID 等定位信息 ----------

test('builder: 输出不包含 conversationId / turnId / 任何 id', () => {
  const secretConv = 'c9f3a1b2-77d4-4e55-9a10-3f8c2b5d6e80'
  const turns = buildTurns(10)
  const handoff = buildConversationHandoff({
    conversationId: secretConv,
    turns,
    checkpoints: [checkpoint(3)]
  })
  const text = formatConversationHandoff(handoff)
  assert.equal(text.includes(secretConv), false, 'conversation UUID 泄漏')
  assert.equal(text.includes('turn-'), false, 'turnId 泄漏')
  assert.equal(text.includes('chk-'), false, 'checkpoint id 泄漏')
  // handoff 结构体本身也不携带 id
  assert.equal(JSON.stringify(handoff.sections).includes(secretConv), false)
  // 只报存在性
  assert.equal(handoff.source.conversationIdAvailable, true)
})

// ---------- 补充：superseded 排除 + checkpoint 上限 ----------

test('builder: superseded checkpoint 永不进入 handoff', () => {
  const turns = buildTurns(10)
  const handoff = buildConversationHandoff({
    conversationId: CONV,
    turns,
    checkpoints: [checkpoint(2), checkpoint(4, { status: 'superseded' })]
  })
  const numbers = handoff.sections.filter((s) => s.kind === 'checkpoint').map((s) => s.turnNumber)
  assert.deepEqual(numbers, [3])
})

test('builder: checkpoint 超上限按 turn 序保留前 N 个 + warning', () => {
  const turns = buildTurns(30)
  const handoff = buildConversationHandoff({
    conversationId: CONV,
    turns,
    checkpoints: [3, 6, 9, 12, 15, 18, 21, 24, 27, 2, 5, 8, 11].map((i) => checkpoint(i))
  })
  assert.equal(handoff.source.checkpointCount, HANDOFF_LIMITS.maxCheckpoints)
  assert.ok(handoff.warnings.some((w) => /checkpoint\(s\) were omitted/.test(w)))
})

test('builder: 无任何 turn → 仅续写规则 + warning，不崩溃', () => {
  const handoff = buildConversationHandoff({ conversationId: CONV, turns: [], checkpoints: [] })
  assert.deepEqual(handoff.sections, [])
  assert.ok(handoff.warnings.length > 0)
  const text = formatConversationHandoff(handoff)
  assert.ok(text.includes('## Continuation Rules'))
  assert.ok(text.includes('## Next Action'))
})

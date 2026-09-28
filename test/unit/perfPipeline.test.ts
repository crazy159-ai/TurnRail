import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyMutations, createMutationPipeline, type MutationContext } from '../../src/content/mutationPipeline.ts'
import { asAssistantUnit, asPlainElement, asTurnRoot, FakeElement, FakeTextNode, record } from './fakeDom.ts'

const SELECTOR_TURN = '[data-turn-key]'
const SELECTOR_ASSISTANT = '[data-chatgpt-search-unit-key$=":assistant"]'

function makeCtx(mountedTargets: Set<FakeElement>): MutationContext {
  return {
    turnSelector: SELECTOR_TURN,
    assistantUnitSelectors: [SELECTOR_ASSISTANT],
    isMountedAssistantTarget: (target) => mountedTargets.has(target as unknown as FakeElement)
  }
}

/** turn 结构：turnRoot ← assistantUnit ← markdown 子节点 */
function makeTurn(id: string): { root: FakeElement; unit: FakeElement; markdown: FakeElement } {
  const root = asTurnRoot(id)
  const unit = asAssistantUnit(`fallback-turn-${id}:0:assistant`)
  const markdown = asPlainElement()
  root.append(unit)
  unit.append(markdown)
  return { root, unit, markdown }
}

/** Spec #60：同一 turn 的 20 条 mutation → dirtyTurns.size === 1 */
test('classify: 同一 turn 20 条记录去重为 1', () => {
  const { markdown } = makeTurn('A')
  const records = Array.from({ length: 20 }, () => record(markdown))
  const batch = classifyMutations(records, makeCtx(new Set()))
  assert.equal(batch.dirtyTurns.size, 1)
  assert.equal(batch.needsFullScan, false)
})

/** Spec #62：已挂载 assistant 内部的 streaming 更新 → 忽略索引，只调度 geometry refresh */
test('classify: assistant streaming 被忽略（不产生 dirty / full scan）', () => {
  const { unit, markdown } = makeTurn('A')
  const mounted = new Set<FakeElement>([markdown, unit])
  const records = [record(markdown), record(unit)]
  const batch = classifyMutations(records, makeCtx(mounted))
  assert.equal(batch.dirtyTurns.size, 0)
  assert.equal(batch.needsFullScan, false)
  assert.equal(batch.assistantStreamOnly, true)
})

/** Pipeline 级：streaming 批 → 只触发 onAssistantStream，不触发 onDirty / onFullScan */
test('pipeline: streaming 批只调度 geometry refresh', () => {
  const { unit, markdown } = makeTurn('A')
  const mounted = new Set<FakeElement>([markdown, unit])
  let dirtyCalls = 0
  let fullCalls = 0
  let streamCalls = 0
  const pipeline = createMutationPipeline(
    makeCtx(mounted),
    {
      onDirty: () => {
        dirtyCalls++
      },
      onFullScan: () => {
        fullCalls++
      },
      onAssistantStream: () => {
        streamCalls++
      }
    },
    5
  )
  pipeline.handle([record(markdown), record(unit)])
  pipeline.flushNow()
  assert.equal(dirtyCalls, 0)
  assert.equal(fullCalls, 0)
  assert.equal(streamCalls, 1)
  pipeline.destroy()
})

/** Spec #63：assistant unit 首次挂载（Store 尚无绑定）→ 不被 streaming 过滤误忽略 */
test('classify: assistant 首次挂载走 dirty 路径', () => {
  const { root, unit } = makeTurn('B')
  // Store 尚未绑定该 assistant → mounted 集为空
  const batch = classifyMutations([record(root, [unit])], makeCtx(new Set()))
  assert.equal(batch.dirtyTurns.size, 1)
  assert.ok(batch.dirtyTurns.has(root as unknown as HTMLElement))
  assert.equal(batch.needsFullScan, false)
})

/** 新 turn：added 节点即 [data-turn-key] → dirty 含该 root */
test('classify: 新 turn root 加入 → dirty', () => {
  const root = asTurnRoot('C')
  const batch = classifyMutations([record(root.parentElement, [root])], makeCtx(new Set()))
  assert.ok(batch.dirtyTurns.has(root as unknown as HTMLElement))
  assert.equal(batch.needsFullScan, false)
})

/** Spec #64/#49：removed 节点含 turn root → dirty（增量调和标记卸载，不删 metadata） */
test('classify: turn root 被移除 → dirty（不直接删数据）', () => {
  const { root } = makeTurn('D')
  const batch = classifyMutations([record(root.parentElement, [], [root])], makeCtx(new Set()))
  assert.ok(batch.dirtyTurns.has(root as unknown as HTMLElement))
})

/** Spec #65：conversation root 级非 turn 变化（横幅/按钮）→ irrelevant，零调度 */
test('pipeline: root 级无关变化不触发任何处理', () => {
  const banner = asPlainElement()
  let anyCall = 0
  const pipeline = createMutationPipeline(
    makeCtx(new Set()),
    {
      onDirty: () => {
        anyCall++
      },
      onFullScan: () => {
        anyCall++
      },
      onAssistantStream: () => {
        anyCall++
      }
    },
    5
  )
  pipeline.handle([record(banner)])
  pipeline.flushNow()
  assert.equal(anyCall, 0)
  pipeline.destroy()
})

/** Spec #70：unknown（无法定位 target）→ 回退 full scan，绝不静默忽略 */
test('pipeline: unknown mutation → scheduleFullScan', () => {
  const orphanText = new FakeTextNode()
  let fullCalls = 0
  let dirtyCalls = 0
  const pipeline = createMutationPipeline(
    makeCtx(new Set()),
    {
      onDirty: () => {
        dirtyCalls++
      },
      onFullScan: () => {
        fullCalls++
      },
      onAssistantStream: () => {}
    },
    5
  )
  pipeline.handle([record(orphanText)])
  pipeline.flushNow()
  assert.equal(fullCalls, 1)
  assert.equal(dirtyCalls, 0)
  pipeline.destroy()
})

/** 去抖批量：handle 多次、一次 flush；full scan 请求优先并清空 dirty 队列 */
test('pipeline: 批量合并 + full scan 优先', () => {
  const a = makeTurn('A')
  const b = makeTurn('B')
  const batches: number[] = []
  let fullCalls = 0
  const pipeline = createMutationPipeline(
    makeCtx(new Set()),
    {
      onDirty: (roots) => {
        batches.push(roots.size)
      },
      onFullScan: () => {
        fullCalls++
      },
      onAssistantStream: () => {}
    },
    5
  )
  pipeline.handle([record(a.markdown)])
  pipeline.handle([record(b.markdown)])
  pipeline.handle([record(new FakeTextNode())]) // unknown → full
  pipeline.flushNow()
  assert.equal(fullCalls, 1)
  assert.equal(batches.length, 0) // full 优先，dirty 队列被清空（full scan 覆盖）
  pipeline.destroy()
})

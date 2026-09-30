import type { ConversationHealthLevel } from '../../src/health/types'

/**
 * Chat Health Golden Cases（P2-2）。
 *
 * 用真实形态的长对话样本锁定"分数区间 + 允许等级"，而非精确分数：
 * 未来调权重 / 调阈值时，只要不破坏这些真实案例的判断就不破坏测试。
 */

export interface HealthCase {
  name: string
  prompts: string[]
  assistants?: string[]
  /** 所有 user turn 的 contentCompleteness（缺省 = Live full） */
  completeness?: 'full' | 'preview'
  expected: {
    scoreMin?: number
    scoreMax?: number
    allowedLevels: ConversationHealthLevel[]
    /** 额外信号断言（可选） */
    assert?: (snapshot: import('../../src/health/types').ConversationHealthSnapshot) => void
  }
}

function seq(template: (i: number) => string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => template(i))
}

/** 中性开发推进 prompt（无纠错 / 反转 / 指代 / 重复模板词） */
const neutral = (i: number) => `继续完善解析器第 ${i + 1} 个函数，保持接口兼容并同步更新注释。`

export const HEALTH_CASES: HealthCase[] = [
  // 1. 短教程
  {
    name: '01 短教程：5 轮同主题问答',
    prompts: [
      'TypeScript 泛型是什么？',
      '泛型约束 extends 怎么用？',
      '给一个 Map 泛型的例子。',
      '这个例子怎么加 readonly？',
      '泛型和 any 的区别？'
    ],
    expected: { scoreMin: 80, allowedLevels: ['healthy'] }
  },
  // 2. 长但稳定代码开发
  {
    name: '02 长但稳定：60 轮连续开发同一模块',
    prompts: seq((i) => `继续完善 parser 模块，第 ${i + 1} 步：保持接口兼容，补充对应单元测试。`, 60),
    expected: { scoreMin: 70, allowedLevels: ['healthy', 'watch'] }
  },
  // 3. 论文连续推导
  {
    name: '03 论文连续推导：30 轮数学推导',
    prompts: seq((i) => `接着上一步推导引理 ${i + 1} 的证明，保持符号一致。`, 30),
    expected: { scoreMin: 70, allowedLevels: ['healthy', 'watch'] }
  },
  // 4. 正常 UI 微调（churn 负例）
  {
    name: '04 正常 UI 微调：14 轮样式与文案修改',
    prompts: seq(
      (i) => `把第 ${i + 1} 个面板的标题改成新的文案，padding 改为 8px。`,
      14
    ),
    expected: { scoreMin: 75, allowedLevels: ['healthy'] }
  },
  // 5. 多文件但目标稳定
  {
    name: '05 多文件引用但目标稳定：20 轮',
    prompts: seq(
      (i) => `参考 module-${i}.ts 与 utils-${i}.md，继续完成数据导出功能的第 ${i + 1} 部分。`,
      20
    ),
    expected: { scoreMin: 70, allowedLevels: ['healthy', 'watch'] }
  },
  // 6. 超长 prompt 但连续任务（长度不应单独触发换聊）
  {
    name: '06 超长 prompt 连续任务：30 轮 × 约 3k 字符',
    prompts: seq(
      (i) =>
        `以下是第 ${i + 1} 步的完整上下文与日志：\n${'A'.repeat(1400)}\n请基于以上内容继续完成导出流程的下一步，保持与既有约定一致。${'B'.repeat(1400)}`,
      30
    ),
    expected: {
      scoreMin: 45,
      allowedLevels: ['healthy', 'watch', 'organize'],
      assert: (s) => {
        if (s.level === 'new-chat') throw new Error('超长但连续的任务不应被判 new-chat')
      }
    }
  },
  // 7. 连续纠错（措辞各异，避免重复放大器干扰）
  {
    name: '07 连续纠错：最近 12 轮多种纠错表达',
    prompts: [
      ...['先看第一版实现。', '再确认接口签名。'],
      '不对，这里理解错了，请重新做。',
      '还是不对，输出和第二轮的要求矛盾。',
      '错了，这个分支条件写反了，重来。',
      '有误，返回类型应该是 Promise，请修正后重做。',
      '你理解错了，我说的是导出格式而不是导入。',
      '仍然不对，异常没有捕获到，重新实现。',
      '这个结果不对，循环边界差了一位。',
      '搞错了，这里应该用 Map 而不是对象。',
      '说错了，我需要的是深度比较，重新写。',
      ' redo 上一版，改动没有生效。',
      '还是不对，请对照需求文档逐步检查。',
      'incorrect again, the schema field is missing.'
    ],
    expected: { scoreMin: 55, scoreMax: 88, allowedLevels: ['watch'] }
  },
  // 8. 方案反复推翻
  {
    name: '08 方案反复推翻：强反转表达密集',
    prompts: [
      ...seq(neutral, 2),
      ...Array.from({ length: 12 }, (_, i) =>
        i % 2 === 0
          ? '不要用之前的方案了，改成事件总线，撤销前面关于单例的决定。'
          : '放弃之前的抽象，回滚到简单函数组合，重新设计架构。'
      )
    ],
    expected: { scoreMin: 55, allowedLevels: ['watch', 'organize'] }
  },
  // 9. 主题突然改变（英文）
  {
    name: '09 主题突变（英文）：Chrome 扩展 → PINN 桥梁',
    prompts: [
      ...Array.from(
        { length: 15 },
        (_, i) =>
          `chrome extension content script: the MutationObserver watches DOM turn nodes, indexer rebuilds rail markers, selector fallback part ${i}.`
      ),
      ...Array.from(
        { length: 5 },
        (_, i) =>
          `physics informed neural network for bridge dynamics: modal analysis, natural frequency, PINN loss for the PDE residual, case ${i}.`
      )
    ],
    expected: {
      allowedLevels: ['watch', 'organize'],
      assert: (s) => {
        if (s.signals.topicDrift < 0.5) throw new Error(`换题后 topicDrift 应显著升高，实际 ${s.signals.topicDrift}`)
      }
    }
  },
  // 10. 反复引用"之前所有结论"
  {
    name: '10 跨轮依赖：长对话 + 密集指代',
    prompts: [
      ...seq(neutral, 48),
      ...Array.from(
        { length: 12 },
        (_, i) => `基于之前第 ${i} 轮的结论，沿用前面确定的目录结构，结合上一轮与上文的约束继续推进。`
      )
    ],
    expected: {
      scoreMin: 70,
      allowedLevels: ['healthy', 'watch'],
      assert: (s) => {
        if (s.signals.referenceDependency < 0.5)
          throw new Error(`密集指代应抬升依赖信号，实际 ${s.signals.referenceDependency}`)
      }
    }
  },
  // 11. 高重复但稳定开发
  {
    name: '11 高重复但稳定：20 轮同项目迭代',
    prompts: seq(
      (i) => `继续完善 TurnRail parser，保持 Provider boundary，补充 parser 单测（第 ${i + 1} 组）。`,
      20
    ),
    expected: { scoreMin: 70, allowedLevels: ['healthy', 'watch'] }
  },
  // 12. 高重复 + 高频纠错（比 11 更差）
  {
    name: '12 高重复 + 高频纠错：12 轮重复纠错',
    prompts: [...seq(neutral, 2), ...Array.from({ length: 12 }, () => '不对，重新做。')],
    expected: { scoreMin: 55, allowedLevels: ['watch', 'organize'] }
  },
  // 13. 中英文混合稳定
  {
    name: '13 中英文混合：18 轮稳定开发',
    prompts: seq(
      (i) => `把 parser 的错误处理补上 retry 机制，第 ${i + 1} 步，参考 health module 的写法。`,
      18
    ),
    expected: { scoreMin: 75, allowedLevels: ['healthy', 'watch'] }
  },
  // 14. 纯缓存 preview（置信度必须在测试中断言 low）
  {
    name: '14 纯缓存 preview：20 轮稳定对话',
    prompts: seq((i) => `继续完善导出模块第 ${i + 1} 步，保持接口兼容。`, 20),
    completeness: 'preview',
    expected: { scoreMin: 70, allowedLevels: ['healthy', 'watch'] }
  },
  // 15. mixed live + cache（置信度 medium）
  {
    name: '15 混合来源：10 轮 live + 10 轮 preview',
    prompts: seq((i) => `继续完善导出模块第 ${i + 1} 步，保持接口兼容。`, 20),
    completeness: 'preview',
    expected: { scoreMin: 70, allowedLevels: ['healthy', 'watch'] }
  },
  // 16. 几乎全 live（置信度 high）
  {
    name: '16 几乎全 live：19 轮 live + 1 轮 preview',
    prompts: seq((i) => `继续完善导出模块第 ${i + 1} 步，保持接口兼容。`, 20),
    expected: { scoreMin: 75, allowedLevels: ['healthy'] }
  },
  // 17. partial 长对话 + 高纠错 + 仅 preview（Test F：不得强建议换聊）
  {
    name: '17 仅 preview + 高纠错：低置信度不得 new-chat',
    prompts: [
      ...seq(neutral, 2),
      ...Array.from({ length: 12 }, () => '不对，重新做。还是不对，纠正一下。')
    ],
    completeness: 'preview',
    expected: {
      scoreMax: 88,
      allowedLevels: ['watch', 'organize'],
      assert: (s) => {
        if (s.level === 'new-chat') throw new Error('低置信度不得输出 new-chat')
      }
    }
  },
  // 18. 多代码块但目标稳定
  {
    name: '18 多代码块稳定：14 轮带代码段',
    prompts: seq(
      (i) => `按这段日志继续排查：\n\`\`\`\nerror at step ${i}: retry\n\`\`\`\n下一步该怎么修？`,
      14
    ),
    expected: { scoreMin: 65, allowedLevels: ['healthy', 'watch'] }
  },
  // 19. 30 轮稳定科研
  {
    name: '19 稳定科研：30 轮实验迭代',
    prompts: seq((i) => `跑第 ${i + 1} 组消融实验，把学习率调成上一组的十分之一并记录结果。`, 30),
    expected: { scoreMin: 70, allowedLevels: ['healthy', 'watch'] }
  },
  // 20. 100 轮稳定单项目
  {
    name: '20 长跑单项目：100 轮稳定推进',
    prompts: seq((i) => `继续完善同一个解析器模块，第 ${i + 1} 步保持接口兼容并补充测试。`, 100),
    expected: {
      scoreMin: 65,
      allowedLevels: ['healthy', 'watch'],
      assert: (s) => {
        if (s.level === 'new-chat' || s.level === 'organize')
          throw new Error(`100 轮稳定单项目不应被判 ${s.level}`)
      }
    }
  }
]

<!-- 标题建议：<type>: <简述>，例如 fix(nav): recover 在空会话时的越界 -->

## 概述

<!-- 这个 PR 做了什么，为什么 -->

## 变更类型

- [ ] bug 修复
- [ ] 新功能
- [ ] 重构（不改变行为）
- [ ] 文档
- [ ] 构建 / CI
- [ ] 测试

## 自查清单

- [ ] `npm run check` 通过（版本一致性 + typecheck + 单元测试 + 生产构建）
- [ ] 涉及导航 / 滚动 / 索引行为的改动已通过 `npm run test:browser`
- [ ] 未新增 Chrome 权限或 host（`test/unit/privacyContract.test.ts` 保持绿）
- [ ] 未新增网络请求（运行时零网络合同保持绿）
- [ ] ChatGPT selector 仍集中在 `src/providers/chatgpt.ts`（`test/unit/providerBoundary.test.ts` 保持绿）
- [ ] column-reverse 滚动行为未破坏（负 scrollTop 合法）
- [ ] 行为变化已同步更新 README

## 隐私影响

<!-- 是否涉及权限 / 网络 / 持久化内容？若涉及 privacy model 变化（新增网络请求、
     新增权限、聊天正文持久化），必须在单独 PR 中进行并说明 rationale。 -->

- [ ] 本 PR 不改变隐私模型
- [ ] 本 PR 属于 privacy model change（单独 PR + README + contract test + rationale）

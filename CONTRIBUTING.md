# Contributing

感谢关注本项目。提交 Issue / PR 前请先阅读以下约定。

## 开发环境

要求 Node.js **22 LTS 或更高**（`package.json` `engines` 声明）。

```bash
npm install
npm run dev          # watch 构建，产物输出到 dist/
npm run typecheck    # TypeScript strict 检查
npm test             # Node 单元测试（tsx 运行 TypeScript）
npm run build        # typecheck + 生产构建
npm run check        # 版本一致性 + 生产构建 + 全部单元测试
npm run test:browser # Playwright 浏览器冒烟测试（首次需 npx playwright install chromium）
```

本地功能验证使用高仿真测试台（无需登录 ChatGPT）：

```bash
node scripts/serve-test-pages.mjs   # 项目根目录，默认 http://127.0.0.1:8931
# fixture: http://127.0.0.1:8931/test/fixture/index.html
# mock:    http://127.0.0.1:8931/test/mock/index.html        （normal 滚动）
#          http://127.0.0.1:8931/test/mock/reverse.html     （column-reverse 滚动）
```

调试日志：页面控制台执行 `localStorage.setItem('tn-debug', '1')` 后刷新，
检查 `__tnDebug`（DOM/滚动几何诊断）与 `__tn`（store/provider/spy 引用）。

## 提交约定

1. **PR 前必须通过** `npm run check`（版本一致性 + typecheck + 单元测试 + 生产构建），
   涉及导航 / 滚动 / 索引行为的改动还需通过 `npm run test:browser`，并在至少一个测试台上自测。
2. 所有针对 ChatGPT 页面结构的查询（selector / data-* 属性）必须集中在
   `src/providers/chatgpt.ts`（`SELECTORS` 表 + Turn-first 解析），其余模块不得直接查询页面 DOM；
   UI / 管道 / 诊断只通过 Provider 接口（`hasRecognizableContent` / `getMutationHints` /
   `getDiagnostics` 等）访问站点信息。该边界由 `test/unit/providerBoundary.test.ts` 自动强制。
3. 所有滚动坐标读写必须经过 `src/navigation/scrollGeometry.ts`
   （normal 与 column-reverse 双坐标系，禁止散落 `Math.max(0, scrollTop)` 之类判断）；
   reverse 滚动回归由浏览器冒烟测试强制。
4. 禁止引入：任何网络请求、遥测/统计、`chrome.storage` 持久化聊天内容、
   undocumented OpenAI API 依赖、非 `textContent` 的正文渲染。
   运行时无网络请求与 manifest 权限边界由 `test/unit/privacyContract.test.ts` 自动强制。
5. 隐私是本项目的硬约束：不发送任何数据、不申请多余权限、不上传聊天内容。

## 隐私模型变更

任何**新增网络请求**、**新增 Chrome 权限**、**聊天正文持久化** 都属于 privacy model change，
必须在单独的 PR 中：更新 README 隐私章节、更新对应 contract test、明确 rationale。
不接受混在功能改动里的隐私边界扩张。

## 报告 Bug

请附上：TurnRail 版本、浏览器版本、操作系统、复现步骤、
`__tn.copyDiagnostics()` 的输出（纯元数据，不含聊天正文）。
不要在 Issue 中粘贴对话内容或完整 DOM。

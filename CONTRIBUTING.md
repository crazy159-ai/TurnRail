# Contributing

感谢关注本项目。提交 Issue / PR 前请先阅读以下约定。

## 开发环境

```bash
npm install
npm run dev        # watch 构建，产物输出到 dist/
npm run typecheck  # TypeScript strict 检查
npm run build      # typecheck + 生产构建
```

本地功能验证使用高仿真测试台（无需登录 ChatGPT）：

```bash
python -m http.server 8931   # 项目根目录
# fixture: http://127.0.0.1:8931/test/fixture/index.html
# mock:    http://127.0.0.1:8931/test/mock/index.html        （normal 滚动）
#          http://127.0.0.1:8931/test/mock/reverse.html     （column-reverse 滚动）
```

调试日志：页面控制台执行 `localStorage.setItem('tn-debug', '1')` 后刷新，
检查 `__tnDebug`（DOM/滚动几何诊断）与 `__tn`（store/provider/spy 引用）。

## 提交约定

1. **PR 前必须通过** `npm run typecheck` 与 `npm run build`，并在至少一个测试台上自测。
2. 所有针对 ChatGPT 页面结构的查询必须集中在 `src/providers/chatgpt.ts`
   （`SELECTORS` 表 + Turn-first 解析），其余模块不得直接查询页面 DOM。
3. 所有滚动坐标读写必须经过 `src/navigation/scrollGeometry.ts`
   （normal 与 column-reverse 双坐标系，禁止散落 `Math.max(0, scrollTop)` 之类判断）。
4. 禁止引入：任何网络请求、遥测/统计、`chrome.storage` 持久化聊天内容、
   undocumented OpenAI API 依赖、非 `textContent` 的正文渲染。
5. 隐私是本项目的硬约束：不发送任何数据、不申请多余权限、不上传聊天内容。

## 报告 Bug

请附上：浏览器版本、`__tnDebug` 输出（不含聊天正文）、复现步骤。
不要在 Issue 中粘贴对话内容。

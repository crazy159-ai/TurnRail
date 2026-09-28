# TurnRail — AI Conversation Navigator

A lightweight conversation navigator for long AI chats. Works on chatgpt.com · No permissions · No telemetry.

在 ChatGPT 网页版（chatgpt.com）右侧添加一个 DeepSeek 风格的"对话导航 / 快速跳转"轨道：
实时索引当前会话的全部用户提问，点击即平滑跳转，滚动时自动高亮当前正在阅读的问题。

全部处理在浏览器本地完成，**不上传、不存储、不泄露任何聊天内容**。

---

## Features

- 右侧极窄 marker 轨道（fixed overlay，不挤压/不修改 ChatGPT 主布局）
- hover 轨道展开浮动目录面板（可 📌 固定），点击任意问题平滑跳转
- 滚动时自动高亮当前问题（rail marker + 面板条目同步）
- 新消息实时加入索引（MutationObserver + 去抖增量扫描）
- 切换会话（SPA 路由）自动重建索引，旧目录不残留
- 长对话支持：
  - 消息被虚拟化卸载后 metadata 保留（目录显示"未加载"标记）
  - 「加载全部历史」：受控向上滚动渐进收获历史（有超时/迭代上限，结束恢复阅读位置）
  - 点击未加载问题自动受控滚动查找（recover），失败安全回退
- 目录内搜索（大小写不敏感子串匹配）
- 深浅色自动跟随 ChatGPT / 系统
- 无障碍：rail 为 navigation 语义、每个 marker 是带 aria-label 的按钮、面板支持键盘焦点与 Esc 关闭

## Installation（Chrome 安装方法）

1. 下载/解压本扩展，得到包含 `manifest.json` 的 `dist/` 目录（或直接使用发布 zip 解压后目录）。
2. 打开 Chrome，访问 `chrome://extensions/`。
3. 打开右上角「开发者模式」。
4. 点击「加载已解压的扩展程序」，选择 `dist/` 目录。
5. 打开 [chatgpt.com](https://chatgpt.com) 任意会话，页面右侧即出现导航轨道。

## Supported ChatGPT URL

- `https://chatgpt.com/*`
- `https://www.chatgpt.com/*`

不申请 `<all_urls>`，未申请任何额外权限（无 storage / tabs / cookies / webRequest 等）。

## Development

```bash
npm install
npm run dev       # watch 模式构建（输出到 dist/）
npm run typecheck # TypeScript strict 检查
```

修改代码后，在 `chrome://extensions/` 中点击扩展的「重新加载」，再刷新 ChatGPT 页面。

调试日志：在页面控制台执行 `localStorage.setItem('tn-debug', '1')` 并刷新（生产默认关闭）。

## Build

```bash
npm install
npm run build     # tsc --noEmit + vite build
npm run zip       # 将 dist/ 打包为 turnrail.zip
```

构建产物：`dist/content.js`（IIFE 单文件 content script）+ `dist/manifest.json` + `dist/icons/`。

## Architecture

```text
ChatGPT DOM
    │
    ▼
ChatGPTAdapter (providers/chatgpt.ts)   ← 全部站点 selector 集中于此
    │  locateMessages / getRole / getText / getTurnElement / getConversationId
    ▼
ConversationIndexer (conversation/indexer.ts)
    │  scan → 去重 → stableId → buildTurns → reconcile
    ├────────────────────┐
    ▼                    ▼
MutationObserver      ScrollSpy (navigation/scrollSpy.ts)
(observers.ts,         缓存偏移 + rAF-free scroll 引擎 + 漂移自检
 150ms 去抖)                │
    └──────────┬───────────┘
               ▼
        ConversationStore (conversation/store.ts)
               │
               ▼
        Navigation UI (ui/, 全部位于 Shadow DOM)
        ┌─────┴─────┐
        ▼           ▼
    marker rail   outline panel
        │
        ▼
  jump / recoverTarget / historyCapture
```

模块职责：

| 模块 | 职责 |
| --- | --- |
| `providers/chatgpt.ts` | 站点适配层：多策略 selector、角色/文本提取、会话 ID、滚动容器定位 |
| `conversation/indexer.ts` | 扫描 → 稳定 ID → 去重 → 调和 turn 列表（含未挂载 turn 的锚定保留） |
| `conversation/store.ts` | 纯数据仓库 + 事件广播；UI 从 store 渲染，不把 DOM 当 store |
| `conversation/historyCapture.ts` | 「加载全部历史」受控滚动捕获 |
| `navigation/scrollSpy.ts` | 阅读位置检测（active turn） |
| `navigation/jump.ts` | 平滑跳转 + sticky header 补偿 + 一次性 outline 脉冲 |
| `navigation/recoverTarget.ts` | 未挂载目标的受控滚动恢复跳转 |
| `navigation/scrollAnchor.ts` | 阅读位置锚点的捕获/恢复 |
| `ui/createShadowRoot.ts` | Shadow DOM host、rail+panel 编排、hover/pin、主题跟随 |
| `ui/rail.ts` / `ui/outline.ts` / `ui/styles.ts` | 轨道 marker、目录面板、全部样式 |
| `content/main.ts` / `bootstrap.ts` / `routeWatcher.ts` / `observers.ts` | 入口与生命周期、SPA 路由检测、DOM 观察器 |

## Privacy

- 所有索引、标题、搜索全部在页面本地内存中完成
- 不发送任何网络请求，不集成任何统计/遥测
- 不写入 `chrome.storage`（V1 仅内存存储）
- 聊天正文仅以 `textContent` 渲染进 Shadow DOM，绝不作为 HTML 注入（防 XSS）
- Manifest 未申请任何 API 权限，仅有 content script 匹配两条 host

## How message detection works（selector 策略）

全部集中在 `src/providers/chatgpt.ts` 的 `SELECTORS` 表中（2026-09 真实 chatgpt.com DOM，已由 DevTools 诊断验证）。

**主路径（Turn-first）**：

```text
[data-thread-find-target="conversation"]   会话根
  └─ [data-turn-key]                       每个 turn（原生稳定 UUID）
       ├─ [data-chatgpt-search-unit-key$=":user"]        user 单元
       │    └─ [data-markdown-text-tone="user-message"]  user 正文
       └─ [data-chatgpt-search-unit-key$=":assistant"]   assistant 单元
            └─ [data-markdown-text-style="assistant-message"]
```

- 只匹配 `:user` / `:assistant` 后缀，不依赖 `fallback-turn-N:0:user` 中的数字
- Turn 稳定 ID：优先 `data-turn-key` 原生 UUID；仅缺失时才回退文本 hash
- 消息 ID：`data-chatgpt-search-message-ids` 首个 token / `data-chatgpt-selection-message-id`
- 正文清理：克隆后移除 `[data-thread-find-skip="true"]` UI 噪声，不触碰附件引用
- 跳转目标：`userUnit`（而非 markdown 内部某个 p），兜底 turn 容器
- 滚动容器：第一优先 `[data-app-action-timeline-scroll]`
- UI 可见性：`hasConversation()`（会话容器存在与否），URL 仅用于 conversationKey

**Legacy fallback**（旧 DOM 兜底，非主路径）：`[data-message-author-role]`、
`article[data-testid^="conversation-turn"]`、`[data-message-id]` 四级降级。

全部策略失效时轨道显示一个警示点，面板显示"无法识别当前对话内容"，不会报错刷屏。

**标题**：本地处理（trim → 合并空白 → 去除 Markdown 修饰 → 60 字符截断加省略号），不调用任何模型或网络。

## How long conversation handling works（长对话策略）

1. **Level 1（自动）**：消息挂载即收获入库；被虚拟化卸载后 metadata 保留、DOM 引用释放，
   目录中标记"未加载"。索引随浏览逐渐完整。
2. **Level 2（用户主动触发）**：点击「加载全部历史」→ 记录阅读锚点 → 渐进向上滚动 →
   等待懒加载渲染 → 收获 → 连续无新增/到顶/达到迭代上限（300 次/45s）即停止 →
   按锚点 + 内容增量精确恢复原阅读位置。
3. **未挂载目标跳转**：点击"未加载"问题 → 判断方向 → 受控逐屏滚动 → 每步收获扫描 →
   命中即跳转；带最大迭代（60 次/20s）与边界终止，失败恢复原位置并提示。
4. **分支/编辑/regenerate**：以"当前可见 branch 为真实索引"；检测到大面积 turn 更换时
   丢弃失效的离线 metadata，不猜测不可见分支。

## Known limitations

- ChatGPT DOM 改版（尤其 `data-turn-key` / `data-chatgpt-search-unit-key` 结构变化）时需更新
  `providers/chatgpt.ts` 中的 `SELECTORS` 表；legacy fallback 的启发式角色推断可能失效。
- 无原生 ID（`data-turn-key` / `data-chatgpt-search-message-ids` 均缺失）时，完全相同文本的问题
  在虚拟化滚动时可能出现序号漂移（ID 重新分配），目录顺序可能短暂重排。
- 分支切换靠启发式检测（"大量卸载 + 大量全新 id"同时出现时重置离线索引），极端场景可能残留少量"未加载"条目。
- 未实现（ roadmap）：书签/重命名、快捷键（Alt+↑/↓、Alt+J）、设置面板、Claude/Gemini/DeepSeek 支持、导出目录。
- 已在 Chrome 114+ 目标下验证；未测其他 Chromium 分支。

## Troubleshooting

| 现象 | 处理 |
| --- | --- |
| 右侧看不到轨道 | 当前不在会话页（新会话 0 提问时隐藏）；或 DOM 策略失效——看面板是否显示"无法识别" |
| 轨道出现但点击无反应 | 控制台执行 `localStorage.setItem('tn-debug','1')` 后刷新，查看 `[TurnRail]` 日志 |
| 部分问题带"未加载" | 该历史尚未被浏览器挂载：点击它自动查找，或用「加载全部历史」 |
| 跳转后目标仍被遮挡 | 极少见；目标样式变化导致 header 测量偏差，欢迎提 issue |

## 测试

- `test/fixture/index.html`：按真实 DOM 构建的最小 fixture，断言
  `turns.length === 1`、`turn.id === user-id-1`、`turn.user.text === "Hello"`、
  `turn.assistant.id === assistant-id-1`、`turn.assistant.text === "Hi"` 等 6 项。
- `test/mock/index.html`：按 2026-09 真实 DOM 结构构建的高仿真测试台
  （含流式输出、懒加载 prepend、虚拟化卸载、SPA 路由切换、重复文本、UI 噪声注入、深浅色）。

```bash
python -m http.server 8931   # 在项目根目录
# fixture: http://127.0.0.1:8931/test/fixture/index.html
# mock:    http://127.0.0.1:8931/test/mock/index.html
```

真实页面验收：控制台执行 `localStorage.setItem('tn-debug','1')` 并刷新，检查 `__tnDebug`：
`conversationRoot > 0`、`turnRoots > 0`、`userUnits > 0`、`storeTurns > 0`、`markers > 0`。

已验证：fixture 6 项断言、12/162 轮索引与唯一性、点击跳转（目标为 userUnit）、滚动高亮
（含顶/底边界）、hover 面板、搜索过滤、会话切换重建、首页/空会话隐藏、流式输出零重建、
虚拟化卸载（153 个"未加载"标记保留）+ 未挂载目标恢复跳转（恢复日志 found=true）、
`[data-thread-find-skip]` 正文清理、「加载全部历史」全流程、控制台零错误。

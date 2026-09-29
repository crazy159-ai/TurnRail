# TurnRail — AI Conversation Navigator

A lightweight conversation navigator for long AI chats. Works on chatgpt.com · Minimal permissions（仅 `storage`） · No telemetry.

在 ChatGPT 网页版（chatgpt.com）右侧添加一个 DeepSeek 风格的"对话导航 / 快速跳转"轨道：
实时索引当前会话的全部用户提问，点击即平滑跳转，滚动时自动高亮当前正在阅读的问题。

全部处理在浏览器本地完成，**不上传、不泄露任何聊天内容**；用户主动缓存的导航元数据仅保存在本机扩展存储中（见下文「Local conversation cache」）。

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
- ⚡ Cached conversation navigation：为选定的会话主动缓存导航元数据，重新打开时目录立即出现（ChatGPT 历史在后台继续加载，TurnRail 自动与真实 DOM 调和绑定）
- 深浅色自动跟随 ChatGPT / 系统
- 无障碍：rail 为 navigation 语义、每个 marker 是带 aria-label 的按钮、面板支持键盘焦点与 Esc 关闭

## Installation（Chrome 安装方法）

**普通用户安装（推荐）：从 GitHub Releases 下载 ZIP**

1. 打开本项目的 [Releases](../../releases) 页面，下载最新版 `turnrail-vX.Y.Z.zip`。
2. 解压 ZIP，得到包含 `manifest.json` 的目录（ZIP 根目录即为扩展根目录）。
3. 打开 Chrome，访问 `chrome://extensions/`，打开右上角「开发者模式」。
4. 点击「加载已解压的扩展程序」，选择解压后的目录。

**开发安装**：本仓库 clone 后执行 `npm install && npm run build`，产物在 `dist/`，
按上述步骤选择 `dist/` 目录加载（修改代码后在 `chrome://extensions/` 中点击「重新加载」）。

5. 打开 [chatgpt.com](https://chatgpt.com) 任意会话，页面右侧即出现导航轨道。

## Releases

正式发布版本通过 [GitHub Releases](../../releases) 提供跨平台构建的 ZIP
（`turnrail-vX.Y.Z.zip`，ZIP 根目录即扩展根目录，解压即可加载）。
Release 由 tag（`vX.Y.Z`）触发，流水线自动完成版本一致性检查、typecheck、单元测试、
浏览器回归测试与打包；用户无需自行构建。

## Supported ChatGPT URL

- `https://chatgpt.com/*`
- `https://www.chatgpt.com/*`

不申请 `<all_urls>`，仅申请 `storage` 权限（本地保存用户主动缓存的导航元数据；未申请 tabs / cookies / webRequest 等）。

## Development

开发环境要求 Node.js **22 LTS 或更高**（`package.json` 的 `engines` 字段声明）。

```bash
npm install
npm run dev         # watch 模式构建（输出到 dist/）
npm run typecheck   # TypeScript strict 检查
npm test            # Node 单元测试（无需浏览器）
npm run build       # typecheck + 生产构建
npm run check       # 版本一致性 + 生产构建 + 全部单元测试（提交 PR 前的一次性门槛）
npm run test:browser  # Playwright 浏览器冒烟测试（Chromium，见「测试」章节）
```

修改代码后，在 `chrome://extensions/` 中点击扩展的「重新加载」，再刷新 ChatGPT 页面。

调试日志：在页面控制台执行 `localStorage.setItem('tn-debug', '1')` 并刷新（生产默认关闭）。
性能指标：`__tnDebug.performance`（TTFR / TTLR / 扫描与 observer 分类计数），`__tn.resetPerformanceStats()` 重置。

## Build

```bash
npm install
npm run build      # tsc --noEmit + vite build
npm run package    # 构建 + 版本一致性检查 + 打包为 release/turnrail-vX.Y.Z.zip（跨平台 Node 实现）
```

构建产物：`dist/content.js`（IIFE 单文件 content script）+ `dist/manifest.json` + `dist/icons/`。
发布 ZIP 由 `npm run package` 生成（`scripts/package.mjs`，Windows / Linux / macOS 通用），
内容只含扩展运行时文件（manifest.json / content.js / icons/）。

## Architecture

```text
ChatGPT DOM
    │
    ▼
ChatGptProvider (providers/chatgpt.ts)   ← 全部站点 selector 集中于此
    │  locateTurns / locateTurnRoots / parseTurn        （Turn-first 主路径）
    │  locateMessages                                   （legacy fallback）
    │  getConversationRoot / getScrollContainer / getConversationId / hasConversation
    │  hasRecognizableContent / getMutationHints / getDiagnostics      （UI・管道・诊断专用）
    ▼
ConversationIndexer (conversation/indexer.ts)
    │  scan（full） / scanDirty（增量）→ 去重 → stableId → reconcile
    ├────────────────────┐
    ▼                    ▼
两层 Observer         ScrollSpy (navigation/scrollSpy.ts)
(observers.ts:         缓存偏移 + rAF-free scroll 引擎 + 漂移自检
 Root Watch + scoped
 Conversation Observer
 + Mutation 分类 +
 Dirty 队列 40ms 批量)      │
    └──────────┬───────────┘
               ▼
        ConversationStore (conversation/store.ts)
               │                │
               ▼                ▼
        Navigation UI      Cache 服务 (cache/)
        (ui/, Shadow DOM)  serialize → hydrate → reconcile
                           落地 chrome.storage.local
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
| `cache/types.ts` / `validate.ts` | 缓存 schema（CachedConversation DTO）与全部入读校验（损坏 / 未来版本 → 忽略） |
| `cache/serializer.ts` / `hydrator.ts` | Runtime Store ↔ 缓存 DTO 显式双向转换（纯数据，无 DOM 依赖） |
| `cache/reconciler.ts` | 缓存与 Live 零重叠时的 stale 判定（分支切换防护） |
| `cache/cacheStore.ts` | chrome.storage.local 持久层（索引 + 全链路容错，失败即 Live-only） |
| `content/observers.ts` | 两层 Observer：短命 Root Watch（root 缺失时等出现）+ scoped Conversation Observer（root 出现即断开 document 级监听） |
| `content/mutationPipeline.ts` | Mutation 分类器 + Dirty Turn 队列（streaming 忽略 / turn 内变化 / unknown 回退 full scan；40ms 批量去重） |
| `content/startupScan.ts` | 启动稳定性退避扫描（100→2400ms，连续 2 次签名不变即停，替代固定 8×400ms） |
| `utils/performance.ts` | PerformanceStats（TTFR / TTLR / full-vs-incremental / observer 分类；仅 tn-debug，无上传） |
| `content/main.ts` / `bootstrap.ts` / `routeWatcher.ts` | 入口与生命周期、SPA 路由检测、缓存桥接、性能标记 |

## Local conversation cache

TurnRail 支持由用户**主动**缓存所选会话的导航元数据（面板头部 ☆/★ 按钮）：
重新打开已缓存的长会话时，导航目录立即出现，无需等待 ChatGPT 完整挂载全部历史 DOM；
随后 TurnRail 在后台与真实 DOM 调和（Reconcile），以 Live 数据为准自动绑定。

**缓存内容**（仅导航元数据）：turn 稳定 ID 与顺序、问题标题（本地截断 ≤60 字符）、
短 preview（本地截断 ≤160 字符）。

**不缓存**：assistant 回答正文 / Markdown、页面 HTML、图片、附件、完整 prompt 全文。

**complete 标记**：仅当「加载全部历史」确认到达顶部（无更多历史）后重写缓存才置 true；
自然打开会话产生的缓存始终为 partial（目录只含已加载部分的 turn）。

存储位置：`chrome.storage.local`（key：`turnrail:conversation:chatgpt:<conversationId>`）。
所有数据保存在本机浏览器内，**TurnRail 不上传任何缓存数据**。缓存永远只是加速层：
损坏或版本不符的缓存会被忽略并回退 Live 重建，任何缓存失败都不影响 TurnRail 正常工作。

## Privacy

TurnRail runs locally in your browser.

- 所有索引、标题、搜索全部在页面本地内存中完成
- 不发送任何网络请求，不集成任何统计/遥测，无任何后端
- 用户主动缓存的导航元数据使用 `chrome.storage.local` 本地保存；TurnRail 不上传缓存数据
- 缓存只含导航元数据（turn ID / 顺序 / 标题 / 短 preview），绝不含回答正文、HTML 或附件
- 聊天正文仅以 `textContent` 渲染进 Shadow DOM，绝不作为 HTML 注入（防 XSS）
- Manifest 仅申请 `storage` 权限 + content script 匹配两条 host

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

## Performance（v1.2）

TurnRail minimizes work on ChatGPT pages by:

- observing the conversation subtree rather than the full document —— 两层 Observer：
  Root Watch 只在 root 缺失时短命观察 document（root 出现即断开），正常状态只观察
  `[data-thread-find-target="conversation"]` 子树；
- incrementally indexing changed turns —— Mutation 分类 → Dirty Turn 队列（40ms 批量去重）
  → 仅解析 dirty / 新增 / 重挂载的 turn，已知且元素仍连接的 turn 零查询跳过；
- ignoring assistant streaming mutations that do not affect navigation —— 已挂载
  assistant unit 内部的流式更新不触发任何索引、目录重建或缓存写入（首次挂载不误伤）；
- restoring cached navigation metadata before live DOM reconciliation —— 缓存目录
  不等 conversation root 出现即可见（cache-first）。

启动重试为稳定性退避（100→2400ms，连续 2 次签名不变即停），不再固定轮询 8 次。
目录 rail 为 keyed 更新（turn 集合未变时零 DOM 重建），outline 面板关闭时不重建。

Debug 指标：`localStorage.setItem('tn-debug','1')` 后查看 `__tnDebug.performance`
（TTFR / TTLR、full vs incremental 扫描数、observer 分类计数），`__tn.resetPerformanceStats()`
重置。仅本地统计，无上传、无聊天正文。

## Roadmap

- **v1.3 — Cache Management & Storage Correctness**：多标签页安全的缓存索引
  （当前共享 `turnrail:cache:index` 为 read-modify-write，last-writer-wins 可能丢条目）、
  recent cache / LRU、存储管理 UI。
- **v1.4 — Large Conversation Scalability**：100 / 300 / 500 / 1000 turn 基准测试；
  当前 `scanDirty()` 虽只解析 dirty turn，但仍经 `locateTurnRoots()` 全量枚举
  （增量解析 ≠ 严格 O(1) 索引，属 v1.2 正常设计），届时按实测决定是否引入
  direct dirty-root upsert、outline virtualization、marker clustering、geometry index。
- **v1.5 — Provider Architecture**：Provider 能力抽象与注册机制。
- **v2.0 — Multi-provider**：Claude / Gemini / DeepSeek 等站点支持。

## Known limitations

- ChatGPT DOM 改版（尤其 `data-turn-key` / `data-chatgpt-search-unit-key` 结构变化）时需更新
  `providers/chatgpt.ts` 中的 `SELECTORS` 表；legacy fallback 的启发式角色推断可能失效。
- 无原生 ID（`data-turn-key` / `data-chatgpt-search-message-ids` 均缺失）时，完全相同文本的问题
  在虚拟化滚动时可能出现序号漂移（ID 重新分配），目录顺序可能短暂重排。
- 分支切换靠启发式检测（"大量卸载 + 大量全新 id"同时出现时重置离线索引），极端场景可能残留少量"未加载"条目。
- 导航缓存只让"已见过的 turn"提前可见：缓存无法凭空提供未加载过的历史；partial 缓存在发现更多 turn 前保持 partial。
- 缓存的分支 / edit / regenerate 行为是 best-effort：Live 与缓存零重叠（判定为另一分支）时丢弃缓存 turn 并以 Live 重建。
- v1.2 已实现：document_end 注入、两层 Observer（范围收窄）、增量 dirty-turn 索引、流式输出过滤、rail keyed 更新；缓存 LRU 自动清理留待 v1.3。
- 未实现（roadmap）：书签/重命名、快捷键（Alt+↑/↓、Alt+J）、设置面板、Claude/Gemini/DeepSeek 支持、导出目录。
- 已在 Chrome 114+ 目标下验证；未测其他 Chromium 分支。

## Troubleshooting

| 现象 | 处理 |
| --- | --- |
| 右侧看不到轨道 | 当前不在会话页（新会话 0 提问时隐藏）；或 DOM 策略失效——看面板是否显示"无法识别" |
| 轨道出现但点击无反应 | 控制台执行 `localStorage.setItem('tn-debug','1')` 后刷新，查看 `[TurnRail]` 日志 |
| 部分问题带"未加载" | 该历史尚未被浏览器挂载：点击它自动查找，或用「加载全部历史」 |
| 跳转后目标仍被遮挡 | 极少见；目标样式变化导致 header 测量偏差，欢迎提 issue |

## 测试

```bash
npm test             # Node 单元测试（tsx 加载 TypeScript，无需浏览器）
npm run test:browser # Playwright 浏览器冒烟测试（Chromium；首次需 npx playwright install chromium）
```

- `test/unit/`：Node 单元测试 —— serialize 纯净性、
  缓存校验（合法 / 损坏 / 未来 schema）、hydrate、缓存×Live reconcile（保序 + Live 胜出 + 不重复）、
  route 竞态隔离、stale 判定与清理、CacheStore 索引 / 清除 / touch、storage 失败降级 Live-only、
  live→cache→hydrate 端到端往返。
  v1.2 增量：Mutation 分类（streaming 忽略 / 首挂载不误伤 / unknown 回退）、Dirty 队列去重与
  批量合并、scanDirty 只解析新 turn（旧 turn 零查询）、卸载 turn metadata 保留、
  启动稳定性退避（恒定签名 3 扫即停 / 不稳定走满 / root 缺失不计稳定）。
  v1.2.1 增量：版本一致性、隐私合同（manifest 权限 / host / 运行时无网络原语）、
  Provider selector 边界、RootWatch 超时低频恢复、诊断导出隐私、打包清单一致性。
- `test/browser/`：Playwright 浏览器冒烟测试，直接自动化下列既有测试资产（无需登录 ChatGPT）。
- `test/fixture/index.html`：按真实 DOM 构建的最小 fixture，断言
  `turns.length === 1`、`turn.id === user-id-1`、`turn.user.text === "Hello"`、
  `turn.assistant.id === assistant-id-1`、`turn.assistant.text === "Hi"` 等 6 项。
- `test/mock/index.html`：按 2026-09 真实 DOM 结构构建的高仿真测试台
  （含流式输出、懒加载 prepend、虚拟化卸载、SPA 路由切换、重复文本、UI 噪声注入、深浅色）。
- `test/mock/reverse.html`：column-reverse 滚动坐标系测试台（复刻真实 ChatGPT）。

本地手动打开测试台（与 Playwright 内置 server 相同的跨平台 Node 实现）：

```bash
node scripts/serve-test-pages.mjs   # 在项目根目录，默认 http://127.0.0.1:8931
# fixture: http://127.0.0.1:8931/test/fixture/index.html
# mock:    http://127.0.0.1:8931/test/mock/index.html
# reverse: http://127.0.0.1:8931/test/mock/reverse.html
```

真实页面验收：控制台执行 `localStorage.setItem('tn-debug','1')` 并刷新，检查 `__tnDebug`：
`conversationRoot > 0`、`turnRoots > 0`、`userUnits > 0`、`storeTurns > 0`、`markers > 0`。

已验证：fixture 6 项断言、12/162 轮索引与唯一性、点击跳转（目标为 userUnit）、滚动高亮
（含顶/底边界）、hover 面板、搜索过滤、会话切换重建、首页/空会话隐藏、流式输出零重建、
虚拟化卸载（153 个"未加载"标记保留）+ 未挂载目标恢复跳转（恢复日志 found=true）、
`[data-thread-find-skip]` 正文清理、「加载全部历史」全流程、控制台零错误。

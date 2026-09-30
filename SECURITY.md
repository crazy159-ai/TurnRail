# 安全策略

## 支持版本

| 版本 | 支持状态 |
| --- | --- |
| 1.2.x | ✅ 支持 |
| < 1.2 | ❌ 请升级 |

## TurnRail 的安全模型

TurnRail 是 **local-first 浏览器扩展**：

- 零网络请求：运行时不发起任何 fetch / XHR / WebSocket（由 `test/unit/privacyContract.test.ts` 强制）
- 最小权限：Manifest V3，仅 `storage` 权限 + 两条 chatgpt.com host（合同测试强制）
- 聊天正文只以 `textContent` 渲染进 Shadow DOM，绝不作为 HTML 注入（防 XSS）
- 本地缓存只含导航元数据（turn ID / 顺序 / 标题 / 短 preview），存于 `chrome.storage.local`，不上传
- **Pending Handoff（Conversation Handoff 功能）是唯一短暂包含聊天正文的本地存储**：
  仅在用户主动确认后写入独立命名空间 `turnrail:handoff:pending`，10 分钟 TTL 到期
  作废、新聊天页注入成功即删除；只填入输入框草稿，TurnRail 没有任何发送消息的
  代码路径；交接文本不经 URL 传递；诊断与控制台零输出（合同测试强制）
- 无 background service worker、无遥测、无后端

## 报告安全漏洞

以下均属安全漏洞：

- XSS（任何正文 / 标题被当作 HTML 渲染的路径）
- 意外网络请求（扩展运行时出现任何出站请求）
- 权限放大（manifest 出现合同之外的权限或 host）
- 缓存元数据泄漏（诊断导出 / 日志 / 缓存内容超出承诺范围）
- 不安全的 DOM 渲染（innerHTML / insertAdjacentHTML 等）

### 如何报告

优先使用 GitHub 的 **Private vulnerability reporting**（仓库 Security 标签页 →
Report a vulnerability）。若该通道不可用，请开一个**最小化的公开 issue** 请求
建立私密报告渠道——但**不要**在公开 issue 中贴出 exploit 细节、用户数据或任何会话内容。

请包含：TurnRail 版本、Chrome 版本、复现步骤、影响评估。我们会在收到后尽快响应。

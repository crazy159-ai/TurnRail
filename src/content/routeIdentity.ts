/**
 * 路由身份（Route Identity）：SPA 路由变化的比较单位。
 *
 * 关键决策：身份不是完整 href。同一会话内的 query / hash / 临时 UI 参数
 * （如 /c/AAA?model=x → /c/AAA?model=y）语义上是同一会话，重置 Store / UI
 * 是无意义甚至有害的（B23）；只有会话 ID 变化（/c/AAA → /c/BBB）或
 * 会话 ↔ 非会话路由切换（/ → /c/BBB）才算路由身份变化。
 *
 * 本模块只做纯数据定义与比较，不查 DOM、不认识 /c/ 站点语义 ——
 * conversation ID 的提取仍由 Provider 负责（bootstrap 注入 getConversationId）。
 */

/** 路由身份：会话路由（含 ID）或非会话路由（首页 / 探索页等） */
export type RouteIdentity =
  | {
      kind: 'conversation'
      conversationId: string
    }
  | {
      kind: 'non-conversation'
      path: string
    }

/** 纯比较 key（绝不进入诊断 / 日志：会话路由的 key 含会话 ID） */
export function routeIdentityKey(identity: RouteIdentity): string {
  return identity.kind === 'conversation'
    ? `conversation:${identity.conversationId}`
    : `page:${identity.path}`
}

/**
 * 读取当前路由身份。conversation ID 由 Provider 注入提取（隔离世界内解析
 * location.pathname）；非会话路由以 pathname 为身份（排除 query / hash 噪声）。
 */
export function readRouteIdentity(getConversationId: () => string | null): RouteIdentity {
  const conversationId = getConversationId()
  if (conversationId) return { kind: 'conversation', conversationId }
  return { kind: 'non-conversation', path: location.pathname }
}

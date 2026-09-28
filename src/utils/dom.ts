/** 合并所有空白为单个空格并 trim */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** 去掉标题开头常见的 Markdown 修饰符号（不改动正文内容） */
export function stripMarkdownDecorations(text: string): string {
  return text
    .replace(/^[#>*\-•·`~\s]+/, '')
    .replace(/[*_`]{1,3}/g, '')
    .trim()
}

/** 按 Unicode 码点截断，避免把 surrogate pair 截一半 */
export function truncateUnicode(text: string, max: number): string {
  const chars = Array.from(text)
  if (chars.length <= max) return text
  return chars.slice(0, max).join('') + '…'
}

export function createEl<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

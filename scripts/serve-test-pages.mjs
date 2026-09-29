#!/usr/bin/env node
/**
 * 跨平台测试台静态服务器（node:http，无第三方依赖、无 python/powershell 依赖）。
 * 服务项目根目录，供 test/fixture 与 test/mock 页面加载 /dist/content.js。
 *
 *   node scripts/serve-test-pages.mjs           # http://127.0.0.1:8931
 *   PORT=9000 node scripts/serve-test-pages.mjs # 自定义端口
 *
 * 仅监听回环地址；仅供本地测试与 Playwright webServer 使用。
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const port = Number(process.env.PORT ?? 8931)
const host = '127.0.0.1'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json'
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${host}:${port}`)
    // 路径归一化 + 目录穿越防护：只允许 root 内的文件
    const pathname = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '')
    const filePath = resolve(root, pathname)
    if (!filePath.startsWith(resolve(root))) {
      res.writeHead(403).end('Forbidden')
      return
    }
    const body = await readFile(filePath)
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('Not Found')
  }
})

server.listen(port, host, () => {
  console.log(`[serve-test-pages] http://${host}:${port}/test/fixture/index.html`)
})

import { createServer, request } from 'http'
import { readFile } from 'fs/promises'
import { resolve, extname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const distDir = resolve(__dirname, 'dist')
const BACKEND = { hostname: '127.0.0.1', port: 3000 }

const mimeTypes = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

const server = createServer(async (req, res) => {
  // Proxy /api requests to backend
  if (req.url.startsWith('/api/')) {
    const targetPath = req.url.slice(4) // remove '/api'
    const proxyReq = request(
      { ...BACKEND, path: targetPath || '/', method: req.method, headers: req.headers },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers)
        proxyRes.pipe(res)
      }
    )
    proxyReq.on('error', (err) => {
      console.error('Proxy error:', err.message)
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Backend unavailable' }))
      }
    })
    if (req.method !== 'GET' && req.method !== 'HEAD') req.pipe(proxyReq)
    else proxyReq.end()
    return
  }

  // Serve static files
  let filePath = resolve(distDir, req.url === '/' ? 'index.html' : req.url.slice(1))
  try {
    const data = await readFile(filePath)
    const ext = extname(filePath)
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' })
    res.end(data)
  } catch {
    // Fallback to index.html for SPA routes
    try {
      const data = await readFile(resolve(distDir, 'index.html'))
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(data)
    } catch {
      res.writeHead(404)
      res.end('Not found')
    }
  }
})

server.listen(3001, '127.0.0.1', () => {
  console.log('Server ready at http://127.0.0.1:3001')
})

/**
 * Frontend-Backend Connection E2E Test
 *
 * 验证完整的端到端链路:
 *   1. 启动后端服务 (localhost:3000)
 *   2. 启动简易 HTTP 代理 (localhost:3001, 代理 /api -> localhost:3000)
 *   3. 通过代理测试后端 API 连通性
 *   4. 测试 WebSocket 连接
 *   5. 清理进程
 *
 * 使用方法:
 *   node tests/frontend-backend-e2e.mjs
 */

import { spawn } from 'child_process'
import { createServer, request } from 'http'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const rootDir = resolve(__dirname, '..')

const BACKEND_URL = 'http://localhost:3000'
const PROXY_URL = 'http://localhost:3001'
const ADMIN_KEY = 'admin-dashboard-key-456'

const colors = {
  reset: '\x1b[0m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
}

function log(label, color = 'reset') {
  console.log(`${colors[color]}${label}${colors.reset}`)
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitForReady(url, label, maxAttempts = 30) {
  let lastErr = ''
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) })
      if (res.status === 200 || res.status === 401 || res.status === 403) {
        log(`  ${label} 已就绪 (${url})`, 'green')
        return true
      }
      lastErr = `状态码 ${res.status}`
    } catch (err) {
      lastErr = err.cause?.message || err.message || String(err)
    }
    await sleep(1000)
  }
  throw new Error(`${label} 在 ${maxAttempts}s 内未就绪 (最后错误: ${lastErr})`)
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${ADMIN_KEY}`,
      ...(opts.headers || {}),
    },
  })
  const data = await res.json().catch(() => ({}))
  return { status: res.status, data }
}

let backendProc = null
let proxyServer = null
let passCount = 0
let failCount = 0

async function testCase(name, fn) {
  log(`  测试: ${name}`, 'gray')
  try {
    await fn()
    log('    PASS', 'green')
    passCount++
  } catch (err) {
    log(`    FAIL: ${err.message}`, 'red')
    failCount++
  }
}

function cleanup() {
  if (backendProc) {
    try { backendProc.kill('SIGTERM') } catch {}
    backendProc = null
  }
  if (proxyServer) {
    try { proxyServer.close() } catch {}
    proxyServer = null
  }
}

process.on('SIGINT', () => {
  log('\n收到中断信号, 正在清理...', 'yellow')
  cleanup()
  process.exit(1)
})

function startProxy() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const targetPath = req.url.replace(/^\/api/, '') || '/'
      const proxyReq = request(
        {
          hostname: 'localhost',
          port: 3000,
          path: targetPath,
          method: req.method,
          headers: req.headers,
        },
        (proxyRes) => {
          res.writeHead(proxyRes.statusCode, proxyRes.headers)
          proxyRes.pipe(res)
        }
      )

      proxyReq.on('error', (err) => {
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: `Proxy error: ${err.message}` }))
        }
      })

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        req.pipe(proxyReq)
      } else {
        proxyReq.end()
      }
    })

    server.listen(3001, () => {
      proxyServer = server
      resolve()
    })
  })
}

function spawnBackend() {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      backendProc = spawn('cmd', ['/c', 'npx', 'tsx', 'src/index.ts'], {
        cwd: rootDir,
        stdio: 'pipe',
        shell: false,
        env: { ...process.env, NODE_ENV: 'test' },
      })
    } else {
      backendProc = spawn('npx', ['tsx', 'src/index.ts'], {
        cwd: rootDir,
        stdio: 'pipe',
        shell: false,
        env: { ...process.env, NODE_ENV: 'test' },
      })
    }

    backendProc.stdout.on('data', (d) => {
      const line = d.toString().trim()
      if (line.includes('Server started')) log(`  [backend] ${line.substring(0, 120)}`, 'gray')
    })
    backendProc.stderr.on('data', (d) => {
      const line = d.toString().trim()
      if (line && !line.includes('DeprecationWarning')) log(`  [backend] ${line.substring(0, 120)}`, 'gray')
    })
    backendProc.on('error', (err) => {
      log(`  [backend] 进程错误: ${err.message}`, 'red')
    })

    resolve()
  })
}

async function main() {
  log('========================================', 'cyan')
  log('  Frontend-Backend E2E Connection Test', 'cyan')
  log('========================================', 'cyan')
  log('')

  // ====== 1. 启动后端 ======
  log('[1/4] 启动后端服务 (端口 3000)...', 'yellow')
  await spawnBackend()
  await waitForReady(`${BACKEND_URL}/health`, '后端')

  // ====== 2. 启动代理 ======
  log('[2/4] 启动代理服务 (端口 3001, 代理 /api -> localhost:3000)...', 'yellow')
  await startProxy()
  log('  代理已就绪 (http://localhost:3001)', 'green')

  // ====== 3. 测试代理连通性 ======
  log('[3/4] 测试代理 -> 后端 API...', 'yellow')

  await testCase('代理 Health 接口', async () => {
    const { status, data } = await fetchJson(`${PROXY_URL}/api/health`)
    if (status !== 200) throw new Error(`状态码 ${status}`)
    if (data.status !== 'ok') throw new Error(`响应异常: ${JSON.stringify(data)}`)
  })

  await testCase('代理 Dashboard 概览', async () => {
    const { status, data } = await fetchJson(`${PROXY_URL}/api/v1/usage/overview`)
    if (status !== 200) throw new Error(`状态码 ${status}`)
    if (typeof data.total_requests !== 'number') throw new Error('缺少 total_requests')
  })

  await testCase('代理租户列表', async () => {
    const { status, data } = await fetchJson(`${PROXY_URL}/api/v1/tenants`)
    if (status !== 200) throw new Error(`状态码 ${status}`)
    if (!Array.isArray(data.tenants)) throw new Error('缺少 tenants 数组')
  })

  await testCase('代理缓存统计', async () => {
    const { status, data } = await fetchJson(`${PROXY_URL}/api/v1/cache`)
    if (status !== 200) throw new Error(`状态码 ${status}`)
    if (typeof data.size !== 'number') throw new Error('缺少 size')
  })

  await testCase('代理 Prometheus 指标', async () => {
    const res = await fetch(`${PROXY_URL}/api/metrics`)
    const text = await res.text()
    if (res.status !== 200) throw new Error(`状态码 ${res.status}`)
    if (!text.includes('gateway_requests_total')) throw new Error('缺少 gateway_requests_total 指标')
  })

  // ====== 4. 测试 WebSocket ======
  log('[4/4] 测试 WebSocket 连接...', 'yellow')

  await testCase('WebSocket 连接到 /v1/ws/admin', async () => {
    return new Promise((resolve, reject) => {
      const wsUrl = `${BACKEND_URL.replace('http', 'ws')}/v1/ws/admin?api_key=${ADMIN_KEY}`
      const ws = new WebSocket(wsUrl)
      const timer = setTimeout(() => {
        ws.close()
        reject(new Error('WebSocket 连接超时'))
      }, 5000)

      ws.onopen = () => {
        clearTimeout(timer)
        ws.close()
        resolve()
      }
      ws.onerror = (err) => {
        clearTimeout(timer)
        reject(new Error(`WebSocket 错误: ${err.message || err}`))
      }
    })
  })

  // ====== 5. 总结 ======
  log('')
  log('========================================', 'cyan')
  log('  测试总结', 'cyan')
  log('========================================', 'cyan')
  log('')
  log(`  通过: ${passCount}`, 'green')
  log(`  失败: ${failCount}`, failCount === 0 ? 'green' : 'red')
  log(`  总计: ${passCount + failCount}`, 'reset')
  log('')

  if (failCount === 0) {
    log('  所有连接测试通过!', 'green')
  } else {
    log('  部分测试失败', 'red')
    process.exitCode = 1
  }
}

main()
  .catch((err) => {
    log(`\n测试异常: ${err.message}`, 'red')
    process.exitCode = 1
  })
  .finally(() => {
    cleanup()
  })

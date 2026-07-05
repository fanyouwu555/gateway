#!/usr/bin/env node
/**
 * AI Gateway 核心功能多维度测试脚本
 * 测试范围：认证、Key 生命周期、Chat Completion、延迟、并发、缓存、Metrics
 */

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const ADMIN_KEY = process.env.ADMIN_KEY;
const EXISTING_USER_KEY = process.env.USER_KEY;

if (!ADMIN_KEY || !EXISTING_USER_KEY) {
  console.error('请设置环境变量 ADMIN_KEY 和 USER_KEY 后运行本脚本');
  console.error('示例: ADMIN_KEY=sk-admin USER_KEY=sk-user node scripts/functional-test.mjs');
  process.exit(1);
}

const COLORS = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

const results = [];
let generatedKey = null;
let tenantId = null;

function log(level, msg) {
  const color = level === 'PASS' ? COLORS.green : level === 'FAIL' ? COLORS.red : level === 'WARN' ? COLORS.yellow : COLORS.cyan;
  console.log(`${color}[${level}]${COLORS.reset} ${msg}`);
}

function logDetail(label, value) {
  console.log(`  ${COLORS.gray}${label}:${COLORS.reset} ${value}`);
}

async function request(path, options = {}) {
  const url = `${BASE_URL}${path}`;
  const start = performance.now();
  try {
    const res = await fetch(url, {
      ...options,
      headers: {
        ...(options.headers || {}),
      },
    });
    const latency = performance.now() - start;
    const body = await res.text();
    let json = null;
    try { json = JSON.parse(body); } catch { /* not json */ }
    return { status: res.status, latency: Math.round(latency * 100) / 100, body: json || body, headers: Object.fromEntries(res.headers) };
  } catch (err) {
    const latency = performance.now() - start;
    return { status: 0, latency: Math.round(latency * 100) / 100, error: err.message, body: null };
  }
}

function record(test, passed, details = {}) {
  results.push({ test, passed, ...details });
  const level = passed ? 'PASS' : 'FAIL';
  log(level, test);
  for (const [k, v] of Object.entries(details)) {
    if (k !== 'passed') logDetail(k, typeof v === 'object' ? JSON.stringify(v) : v);
  }
}

// ===========================
// 1. 公开端点测试
// ===========================
async function testPublicEndpoints() {
  console.log(`\n${COLORS.cyan}=== 1. 公开端点测试 ===${COLORS.reset}`);

  const health = await request('/health');
  record('Health Check', health.status === 200, {
    status: health.status,
    latency_ms: health.latency,
    uptime: health.body?.uptime ? `${Math.round(health.body.uptime)}s` : 'N/A',
  });

  const root = await request('/');
  record('Root Info', root.status === 200, {
    status: root.status,
    latency_ms: root.latency,
  });

  const metrics = await request('/metrics');
  record('Prometheus Metrics', metrics.status === 200, {
    status: metrics.status,
    latency_ms: metrics.latency,
    content_length: metrics.body?.length || 'N/A',
  });
}

// ===========================
// 2. 认证与 Key 生成测试
// ===========================
async function testAuthAndKeyGeneration() {
  console.log(`\n${COLORS.cyan}=== 2. 认证与 Key 生成测试 ===${COLORS.reset}`);

  // 2.1 Admin Key 验证
  const adminVerify = await request('/v1/auth/verify', {
    headers: { Authorization: `Bearer ${ADMIN_KEY}` },
  });
  record('Admin Key Verification', adminVerify.status === 200 && adminVerify.body?.is_admin === true, {
    status: adminVerify.status,
    latency_ms: adminVerify.latency,
    is_admin: adminVerify.body?.is_admin,
    tenant_id: adminVerify.body?.tenant_id,
  });

  // 2.2 现有 User Key 不能访问 Admin-only 的 /v1/auth/verify
  const userVerify = await request('/v1/auth/verify', {
    headers: { Authorization: `Bearer ${EXISTING_USER_KEY}` },
  });
  record('Existing User Key → Admin Route Blocked', userVerify.status === 403, {
    status: userVerify.status,
    latency_ms: userVerify.latency,
  });

  // 2.3 无效 Key 拒绝
  const invalidAuth = await request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk-invalid-key-xxx' },
    body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }] }),
  });
  record('Invalid Key Rejection', invalidAuth.status === 401, {
    status: invalidAuth.status,
    latency_ms: invalidAuth.latency,
    error_code: invalidAuth.body?.error?.code,
  });

  // 2.4 无 Key 拒绝
  const noAuth = await request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }] }),
  });
  record('Missing Key Rejection', noAuth.status === 401, {
    status: noAuth.status,
    latency_ms: noAuth.latency,
    error_code: noAuth.body?.error?.code,
  });

  // 2.5 创建租户
  const tenantRes = await request('/v1/tenants', {
    method: 'POST',
    headers: { Authorization: `Bearer ${ADMIN_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Test Tenant',
      status: 'active',
      plan: 'pro',
      settings: { allowed_providers: ['volcano', 'kimi-code'] },
      limits: { daily_requests: 1000, daily_tokens: 100000, max_api_keys: 5, concurrent_requests: 10 },
    }),
  });
  record('Create Tenant', tenantRes.status === 201, {
    status: tenantRes.status,
    latency_ms: tenantRes.latency,
    tenant_id: tenantRes.body?.tenant_id,
  });
  tenantId = tenantRes.body?.tenant_id;

  // 2.6 为租户创建 API Key
  if (tenantId) {
    const keyRes = await request(`/v1/tenants/${tenantId}/keys`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ADMIN_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Functional Test Key', allowed_models: ['ark-code-latest', 'kimi-for-coding'] }),
    });
    record('Create API Key', keyRes.status === 201 && keyRes.body?.key?.startsWith('sk-'), {
      status: keyRes.status,
      latency_ms: keyRes.latency,
      key_name: keyRes.body?.name,
      key_prefix: keyRes.body?.key?.slice(0, 12) + '...',
    });
    generatedKey = keyRes.body?.key;

    // 2.7 验证新 Key 可用（用 /v1/models 测试认证通过）
    if (generatedKey) {
      const newKeyModels = await request('/v1/models', {
        headers: { Authorization: `Bearer ${generatedKey}` },
      });
      record('New Key Authentication', newKeyModels.status === 200, {
        status: newKeyModels.status,
        latency_ms: newKeyModels.latency,
        model_count: Array.isArray(newKeyModels.body?.data) ? newKeyModels.body.data.length : 0,
      });
    }

    // 2.8 验证新 Key 不能访问 Admin 路由（租户隔离）
    if (generatedKey) {
      const isolationTest = await request('/v1/tenants', {
        headers: { Authorization: `Bearer ${generatedKey}` },
      });
      record('Tenant Isolation (User Key → Admin Route)', isolationTest.status === 403, {
        status: isolationTest.status,
        latency_ms: isolationTest.latency,
      });
    }
  }
}

// ===========================
// 3. 核心功能测试
// ===========================
async function testCoreFeatures() {
  console.log(`\n${COLORS.cyan}=== 3. 核心功能测试 ===${COLORS.reset}`);

  const testKey = generatedKey || EXISTING_USER_KEY;

  // 3.1 List Models
  const modelsRes = await request('/v1/models', {
    headers: { Authorization: `Bearer ${testKey}` },
  });
  const modelCount = Array.isArray(modelsRes.body?.data) ? modelsRes.body.data.length : 0;
  record('List Models', modelsRes.status === 200 && modelCount > 0, {
    status: modelsRes.status,
    latency_ms: modelsRes.latency,
    model_count: modelCount,
  });

  // 3.2 Chat Completion (Volcano Engine - real provider)
  const chatStart = performance.now();
  const chatRes = await request('/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${testKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'ark-code-latest',
      messages: [{ role: 'user', content: '你好，请用一句话介绍自己' }],
      max_tokens: 100,
    }),
  });
  const chatLatency = Math.round((performance.now() - chatStart) * 100) / 100;
  const chatOk = chatRes.status === 200 && chatRes.body?.choices?.[0]?.message?.content;
  record('Chat Completion (Volcano)', chatOk, {
    status: chatRes.status,
    latency_ms: chatLatency,
    provider: chatRes.body?.provider || 'volcano',
    model: chatRes.body?.model,
    content_preview: chatOk ? chatRes.body.choices[0].message.content.slice(0, 60) + '...' : 'N/A',
    usage: chatRes.body?.usage || null,
    error: chatRes.body?.error?.message || null,
  });

  // 3.3 Chat Completion (Kimi Code - real provider)
  const chat2Start = performance.now();
  const chat2Res = await request('/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${testKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'kimi-for-coding',
      messages: [{ role: 'user', content: 'Hello, introduce yourself in one sentence' }],
      max_tokens: 100,
    }),
  });
  const chat2Latency = Math.round((performance.now() - chat2Start) * 100) / 100;
  const chat2Ok = chat2Res.status === 200 && chat2Res.body?.choices?.[0]?.message?.content;
  record('Chat Completion (Kimi Code)', chat2Ok, {
    status: chat2Res.status,
    latency_ms: chat2Latency,
    provider: chat2Res.body?.provider || 'kimi-code',
    model: chat2Res.body?.model,
    content_preview: chat2Ok ? chat2Res.body.choices[0].message.content.slice(0, 60) + '...' : 'N/A',
    usage: chat2Res.body?.usage || null,
    error: chat2Res.body?.error?.message || null,
  });

  // 3.4 Invalid Model 处理（使用 existing user key，无 allowed_models 限制）
  const invalidModelRes = await request('/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${EXISTING_USER_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'non-existent-model-xyz',
      messages: [{ role: 'user', content: 'test' }],
    }),
  });
  record('Invalid Model Handling', invalidModelRes.status === 400, {
    status: invalidModelRes.status,
    latency_ms: invalidModelRes.latency,
    error_type: invalidModelRes.body?.error?.type,
    error_code: invalidModelRes.body?.error?.code,
  });

  // 3.5 Guardrail 测试（敏感词过滤）
  const guardrailRes = await request('/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${testKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'ark-code-latest',
      messages: [{ role: 'user', content: 'This contains test-bad-word in it' }],
    }),
  });
  record('Guardrail Block (Sensitive Word)', guardrailRes.status === 400, {
    status: guardrailRes.status,
    latency_ms: guardrailRes.latency,
    error_code: guardrailRes.body?.error?.code,
  });
}

// ===========================
// 4. 延迟与性能测试
// ===========================
async function testLatencyAndPerformance() {
  console.log(`\n${COLORS.cyan}=== 4. 延迟与性能测试 ===${COLORS.reset}`);

  const testKey = generatedKey || EXISTING_USER_KEY;

  // 4.1 串行多次请求延迟基准
  const serialLatencies = [];
  const SERIAL_COUNT = 3;
  for (let i = 0; i < SERIAL_COUNT; i++) {
    const start = performance.now();
    const res = await request('/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${testKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'ark-code-latest',
        messages: [{ role: 'user', content: `Serial latency test #${i + 1}` }],
        max_tokens: 50,
      }),
    });
    const latency = Math.round((performance.now() - start) * 100) / 100;
    serialLatencies.push({ status: res.status, latency });
  }
  const okSerial = serialLatencies.filter(l => l.status === 200);
  const avgSerial = okSerial.length > 0 ? okSerial.reduce((a, b) => a + b.latency, 0) / okSerial.length : 0;
  const minSerial = okSerial.length > 0 ? Math.min(...okSerial.map(l => l.latency)) : 0;
  const maxSerial = okSerial.length > 0 ? Math.max(...okSerial.map(l => l.latency)) : 0;
  record(`Serial ${SERIAL_COUNT}x Chat Latency`, okSerial.length === SERIAL_COUNT, {
    success_count: okSerial.length,
    avg_latency_ms: Math.round(avgSerial * 100) / 100,
    min_latency_ms: minSerial,
    max_latency_ms: maxSerial,
  });

  // 4.2 并发请求测试
  const CONCURRENT_COUNT = 5;
  const concurrentStart = performance.now();
  const concurrentPromises = Array.from({ length: CONCURRENT_COUNT }, (_, i) =>
    request('/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${testKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'ark-code-latest',
        messages: [{ role: 'user', content: `Concurrent test #${i + 1}` }],
        max_tokens: 50,
      }),
    })
  );
  const concurrentResults = await Promise.all(concurrentPromises);
  const concurrentTotal = Math.round((performance.now() - concurrentStart) * 100) / 100;
  const okConcurrent = concurrentResults.filter(r => r.status === 200);
  const concurrentLatencies = okConcurrent.map(r => r.latency);
  const avgConcurrent = concurrentLatencies.length > 0 ? concurrentLatencies.reduce((a, b) => a + b, 0) / concurrentLatencies.length : 0;
  record(`Concurrent ${CONCURRENT_COUNT}x Chat`, okConcurrent.length === CONCURRENT_COUNT, {
    success_count: okConcurrent.length,
    total_time_ms: concurrentTotal,
    avg_latency_ms: Math.round(avgConcurrent * 100) / 100,
    min_latency_ms: concurrentLatencies.length > 0 ? Math.min(...concurrentLatencies) : 0,
    max_latency_ms: concurrentLatencies.length > 0 ? Math.max(...concurrentLatencies) : 0,
  });

  // 4.3 缓存命中测试
  const cacheBody = JSON.stringify({
    model: 'ark-code-latest',
    messages: [{ role: 'user', content: 'Cache hit test message' }],
    max_tokens: 50,
  });
  const cache1 = await request('/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${testKey}`, 'Content-Type': 'application/json' },
    body: cacheBody,
  });
  const cache2 = await request('/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${testKey}`, 'Content-Type': 'application/json' },
    body: cacheBody,
  });
  const cacheHit = cache2.status === 200 && cache2.latency < cache1.latency * 0.5;
  record('Cache Hit Test', cacheHit, {
    first_latency_ms: cache1.latency,
    second_latency_ms: cache2.latency,
    speedup: cache1.latency > 0 ? Math.round((cache1.latency / cache2.latency) * 100) / 100 : 0,
  });

  // 4.4 请求 Metrics 端点获取 Prometheus 指标
  const metricsRes = await request('/metrics');
  const hasAiMetrics = metricsRes.body &&
    (metricsRes.body.includes('gateway_ai_ttfb_ms') ||
     metricsRes.body.includes('gateway_ai_tokens_total'));
  record('Prometheus AI Metrics Exported', hasAiMetrics, {
    status: metricsRes.status,
    latency_ms: metricsRes.latency,
    has_ai_metrics: hasAiMetrics,
  });
}

// ===========================
// 5. 管理功能测试
// ===========================
async function testAdminFeatures() {
  console.log(`\n${COLORS.cyan}=== 5. 管理功能测试 ===${COLORS.reset}`);

  // 5.1 用量概览
  const overviewRes = await request('/v1/usage/overview', {
    headers: { Authorization: `Bearer ${ADMIN_KEY}` },
  });
  record('Admin Usage Overview', overviewRes.status === 200, {
    status: overviewRes.status,
    latency_ms: overviewRes.latency,
    total_requests: overviewRes.body?.total_requests,
    total_tokens: overviewRes.body?.total_tokens,
    success_rate: overviewRes.body?.success_rate,
  });

  // 5.2 Provider 统计
  const providerStatsRes = await request('/v1/usage/providers', {
    headers: { Authorization: `Bearer ${ADMIN_KEY}` },
  });
  record('Admin Provider Stats', providerStatsRes.status === 200, {
    status: providerStatsRes.status,
    latency_ms: providerStatsRes.latency,
    provider_count: Array.isArray(providerStatsRes.body) ? providerStatsRes.body.length : 0,
  });

  // 5.3 路由状态
  const routerRes = await request('/v1/router/status', {
    headers: { Authorization: `Bearer ${ADMIN_KEY}` },
  });
  record('Admin Router Status', routerRes.status === 200, {
    status: routerRes.status,
    latency_ms: routerRes.latency,
    strategy: routerRes.body?.strategy,
    rule_count: routerRes.body?.rules?.length,
  });

  // 5.4 配额状态
  const quotaRes = await request('/v1/quota', {
    headers: { Authorization: `Bearer ${ADMIN_KEY}` },
  });
  record('Admin Quota Status', quotaRes.status === 200, {
    status: quotaRes.status,
    latency_ms: quotaRes.latency,
    quota: quotaRes.body,
  });

  // 5.5 缓存统计
  const cacheRes = await request('/v1/cache', {
    headers: { Authorization: `Bearer ${ADMIN_KEY}` },
  });
  record('Admin Cache Stats', cacheRes.status === 200, {
    status: cacheRes.status,
    latency_ms: cacheRes.latency,
    cache_size: cacheRes.body?.size,
    hit_rate: cacheRes.body?.hit_rate,
  });

  // 5.6 Key 用量统计（如果生成了 key）
  if (tenantId && generatedKey) {
    // 需要先获取 key hash 才能查用量
    const keysRes = await request(`/v1/tenants/${tenantId}/keys`, {
      headers: { Authorization: `Bearer ${ADMIN_KEY}` },
    });
    if (keysRes.status === 200 && Array.isArray(keysRes.body?.keys) && keysRes.body.keys.length > 0) {
      const keyHash = keysRes.body.keys[0].key;
      const keyUsageRes = await request(`/v1/tenants/${tenantId}/keys/${keyHash}/usage`, {
        headers: { Authorization: `Bearer ${ADMIN_KEY}` },
      });
      record('Admin Key Usage Stats', keyUsageRes.status === 200, {
        status: keyUsageRes.status,
        latency_ms: keyUsageRes.latency,
        usage: keyUsageRes.body?.usage,
      });
    }
  }
}

// ===========================
// 6. 清理
// ===========================
async function cleanup() {
  console.log(`\n${COLORS.cyan}=== 6. 清理 ===${COLORS.reset}`);

  if (tenantId && generatedKey) {
    // 删除生成的 key
    const delKeyRes = await request(`/v1/keys/${generatedKey}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${ADMIN_KEY}` },
    });
    record('Delete Generated Key', delKeyRes.status === 200, {
      status: delKeyRes.status,
      latency_ms: delKeyRes.latency,
    });

    // 删除租户
    const delTenantRes = await request(`/v1/tenants/${tenantId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${ADMIN_KEY}` },
    });
    record('Delete Test Tenant', delTenantRes.status === 200, {
      status: delTenantRes.status,
      latency_ms: delTenantRes.latency,
    });
  }
}

// ===========================
// 汇总报告
// ===========================
function printReport() {
  console.log(`\n${COLORS.cyan}========================================`);
  console.log('         测试汇总报告');
  console.log(`========================================${COLORS.reset}`);

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  const total = results.length;

  console.log(`\n总测试数: ${total}`);
  console.log(`${COLORS.green}通过: ${passed}${COLORS.reset}`);
  console.log(`${COLORS.red}失败: ${failed}${COLORS.reset}`);
  console.log(`通过率: ${Math.round((passed / total) * 100)}%`);

  if (failed > 0) {
    console.log(`\n${COLORS.red}失败项详情:${COLORS.reset}`);
    for (const r of results.filter(r => !r.passed)) {
      console.log(`  - ${r.test}`);
    }
  }

  const latencies = results
    .filter(r => r.latency_ms !== undefined)
    .map(r => r.latency_ms);
  if (latencies.length > 0) {
    const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    const min = Math.min(...latencies);
    const max = Math.max(...latencies);
    console.log(`\n延迟统计 (ms):`);
    console.log(`  平均: ${Math.round(avg * 100) / 100}`);
    console.log(`  最小: ${min}`);
    console.log(`  最大: ${max}`);
  }

  console.log('');
}

// ===========================
// Main
// ===========================
async function main() {
  console.log(`${COLORS.cyan}AI Gateway 核心功能多维度测试${COLORS.reset}`);
  console.log(`目标: ${BASE_URL}`);
  console.log(`时间: ${new Date().toLocaleString()}`);

  try {
    await testPublicEndpoints();
    await testAuthAndKeyGeneration();
    await testCoreFeatures();
    await testLatencyAndPerformance();
    await testAdminFeatures();
    await cleanup();
  } catch (err) {
    log('FAIL', `测试过程中出现错误: ${err.message}`);
    console.error(err);
  }

  printReport();
}

main().catch(console.error);

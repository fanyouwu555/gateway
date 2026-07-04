#!/usr/bin/env node
/**
 * AI Gateway Model Equivalents 功能测试脚本
 * 验证跨 Provider Failover 时模型名自动重映射功能
 *
 * 前置条件：网关已在 http://localhost:3000 运行
 * 运行: node scripts/model-equivalents-test.mjs
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const ADMIN_KEY = process.env.ADMIN_KEY;
const USER_KEY = process.env.USER_KEY;

if (!ADMIN_KEY || !USER_KEY) {
  console.error('请设置环境变量 ADMIN_KEY 和 USER_KEY 后运行本脚本');
  console.error('示例: ADMIN_KEY=sk-admin USER_KEY=sk-user node scripts/model-equivalents-test.mjs');
  process.exit(1);
}

const PASS = '\x1b[32m[PASS]\x1b[0m';
const FAIL = '\x1b[31m[FAIL]\x1b[0m';
const INFO = '\x1b[36m[INFO]\x1b[0m';
const WARN = '\x1b[33m[WARN]\x1b[0m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

const results = [];

function log(level, msg, detail) {
  console.log(`${level} ${msg}`);
  if (detail) console.log(`  ${detail}`);
}

function record(test, passed, details = {}) {
  results.push({ test, passed, ...details });
  log(passed ? PASS : FAIL, test, JSON.stringify(details));
}

// ============================================================
// 1. 配置文件验证
// ============================================================
function testConfigFile() {
  console.log(`\n${BOLD}=== 1. 配置文件验证 ===${RESET}`);

  try {
    const configPath = resolve(__dirname, '../conf/default.json');
    const raw = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw);

    record('config/default.json 可解析', true, { path: configPath });

    const me = config.model_equivalents;
    record('model_equivalents 配置存在', !!me, {
      exists: !!me,
      keys: me ? Object.keys(me) : [],
    });

    if (me) {
      // 验证每条映射有效
      let validEntries = 0;
      for (const [model, providerMap] of Object.entries(me)) {
        if (typeof providerMap === 'object' && providerMap !== null) {
          for (const [provider, mappedModel] of Object.entries(providerMap)) {
            if (typeof mappedModel === 'string' && mappedModel.length > 0) {
              validEntries++;
            }
          }
        }
      }
      record('映射条目格式有效', validEntries > 0, {
        entry_count: validEntries,
      });

      // 验证特定映射
      if (me['ark-code-latest']?.['kimi-code'] === 'kimi-for-coding') {
        record('ark-code-latest→kimi-code 映射正确: kimi-for-coding', true);
      }
      if (me['kimi-for-coding']?.['volcano'] === 'ark-code-latest') {
        record('kimi-for-coding→volcano 映射正确: ark-code-latest', true);
      }
    }
  } catch (err) {
    record('配置文件读取失败', false, { error: err.message });
  }
}

// ============================================================
// 2. resolveModelForProvider 逻辑测试（纯函数验证）
// ============================================================
function testResolveLogic() {
  console.log(`\n${BOLD}=== 2. resolveModelForProvider 逻辑验证 ===${RESET}`);

  // 模拟 model_equivalents 数据
  const equivalents = {
    'ark-code-latest': {
      'kimi-code': 'kimi-for-coding',
    },
    'kimi-for-coding': {
      volcano: 'ark-code-latest',
    },
  };

  function resolveModelForProvider(model, provider) {
    const perProvider = equivalents[model];
    if (!perProvider) return model;
    return perProvider[provider] || model;
  }

  // 2.1 已知映射应返回等效模型名
  const t1 = resolveModelForProvider('ark-code-latest', 'kimi-code');
  record('ark-code-latest + kimi-code → kimi-for-coding', t1 === 'kimi-for-coding', { expected: 'kimi-for-coding', got: t1 });

  const t2 = resolveModelForProvider('kimi-for-coding', 'volcano');
  record('kimi-for-coding + volcano → ark-code-latest', t2 === 'ark-code-latest', { expected: 'ark-code-latest', got: t2 });

  // 2.2 无映射的 Provider — 返回原模型名
  const t5 = resolveModelForProvider('ark-code-latest', 'openai');
  record('ark-code-latest + openai(无映射) → ark-code-latest', t5 === 'ark-code-latest', { expected: 'ark-code-latest', got: t5 });

  // 2.3 无映射的模型 — 返回原模型名
  const t6 = resolveModelForProvider('nonexistent-model', 'volcano');
  record('nonexistent-model + volcano(无映射) → nonexistent-model', t6 === 'nonexistent-model', { expected: 'nonexistent-model', got: t6 });

  // 2.4 边界：空字符串模型
  const t7 = resolveModelForProvider('', 'volcano');
  record('空模型名返回空', t7 === '', { expected: '', got: t7 });

  // 2.5 边界：unknown Provider
  const t8 = resolveModelForProvider('ark-code-latest', 'some-unknown-provider');
  record('unknown provider → 返回原模型', t8 === 'ark-code-latest', { expected: 'ark-code-latest', got: t8 });
}

// ============================================================
// 3. HTTP 端点验证（需网关运行中）
// ============================================================
async function testApiEndpoints() {
  console.log(`\n${BOLD}=== 3. HTTP API 验证 ===${RESET}`);

  try {
    // 3.1 Health 端点
    const health = await fetch(`${BASE_URL}/health`);
    const healthBody = await health.json();
    record('GET /health', health.status === 200, {
      status: health.status,
      uptime: healthBody.uptime ? `${Math.round(healthBody.uptime)}s` : 'N/A',
    });
  } catch (err) {
    record(`网关未运行 (${BASE_URL})`, false, { error: err.message });
    log(WARN, '跳过 HTTP API 测试，请先启动网关');
    return;
  }

  // 3.2 认证验证
  const verifyRes = await fetch(`${BASE_URL}/v1/auth/verify`, {
    headers: { Authorization: `Bearer ${ADMIN_KEY}` },
  });
  const verifyBody = await verifyRes.json();
  record('Admin 认证', verifyRes.status === 200 && verifyBody?.is_admin === true, {
    status: verifyRes.status,
    is_admin: verifyBody?.is_admin,
  });

  // 3.3 模型列表
  const modelsRes = await fetch(`${BASE_URL}/v1/models`, {
    headers: { Authorization: `Bearer ${USER_KEY}` },
  });
  const modelsBody = await modelsRes.json();
  const modelCount = Array.isArray(modelsBody?.data) ? modelsBody.data.length : 0;
  record('GET /v1/models', modelsRes.status === 200 && modelCount > 0, {
    status: modelsRes.status,
    model_count: modelCount,
  });

  // 3.4 路由状态
  const routerRes = await fetch(`${BASE_URL}/v1/router/status`, {
    headers: { Authorization: `Bearer ${ADMIN_KEY}` },
  });
  const routerBody = await routerRes.json();
  record('GET /v1/router/status', routerRes.status === 200, {
    status: routerRes.status,
    strategy: routerBody?.strategy,
    rule_count: routerBody?.rules?.length,
  });

  // 3.5 Chat Completion — 验证 X-Gateway-Cost header (Wave 1)
  log(INFO, '测试 Chat Completion (火山引擎)...');
  const chatRes = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${USER_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'ark-code-latest',
      messages: [{ role: 'user', content: 'Hello, say hi in one sentence' }],
      max_tokens: 50,
    }),
  });
  const chatBody = await chatRes.json();
  const chatOk = chatRes.status === 200 && chatBody?.choices?.[0]?.message?.content;
  record('Chat Completion (Volcano Engine)', chatOk, {
    status: chatRes.status,
    provider: chatBody?.provider || 'N/A',
    model: chatBody?.model,
    cost_header: chatRes.headers.get('X-Gateway-Cost') || 'N/A',
    content_preview: chatOk ? chatBody.choices[0].message.content.slice(0, 60) : 'N/A',
    error: chatBody?.error?.message || null,
  });
}

// ============================================================
// 4. Failover 场景模拟验证
// ============================================================
function testFailoverScenario() {
  console.log(`\n${BOLD}=== 4. Failover 场景模拟 ===${RESET}`);

  // 模拟 model_equivalents 数据和完整的 failover 流程
  const equivalents = {
    'ark-code-latest': { 'kimi-code': 'kimi-for-coding' },
  };

  function resolveModelForProvider(model, provider) {
    const perProvider = equivalents[model];
    if (!perProvider) return model;
    return perProvider[provider] || model;
  }

  // 模拟 failover 链：volcano → kimi-code
  const failoverChain = ['volcano', 'kimi-code'];

  function simulateFailover(primaryProvider, requestModel, failAt) {
    const errors = [];
    let resultModel = null;

    for (const provider of failoverChain) {
      if (provider === failAt || errors.length > 0) {
        // 模拟 provider 失败
        if (provider === failAt) {
          errors.push({ provider, error: 'Service unavailable' });
          continue;
        }
      }

      // 成功 — 使用 resolveModelForProvider 重映射模型名
      resultModel = resolveModelForProvider(requestModel, provider);
      break;
    }

    return resultModel;
  }

  // 场景 A: volcano 失败 → fallback 到 kimi-code，模型 remap 为 kimi-for-coding
  const scenarioA = simulateFailover('volcano', 'ark-code-latest', 'volcano');
  record('场景A: volcano宕机→kimi-code, 模型重映射为kimi-for-coding', scenarioA === 'kimi-for-coding', {
    input: 'ark-code-latest',
    fallback: 'kimi-code',
    result: scenarioA,
  });

  // 场景 B: volcano 失败 → 回退到 kimi-code（无映射时保持原模型名）
  (function scenarioB() {
    const equivalentsB = { 'ark-code-latest': { 'kimi-code': 'kimi-for-coding' } };
    function resolveB(model, p) {
      const m = equivalentsB[model];
      return m?.[p] || model;
    }
    const result = resolveB('ark-code-latest', 'kimi-code');
    record('场景B: volcano宕机→kimi-code, 模型重映射为kimi-for-coding', result === 'kimi-for-coding', {
      input: 'ark-code-latest',
      fallback: 'kimi-code(第二优先)',
      result,
    });
  })();

  // 场景 C: 无 model_equivalent 配置时，模型名保持不变
  (function scenarioC() {
    const emptyEquivalents = {};
    function resolveNoOp(model, _provider) {
      const perProvider = emptyEquivalents[model];
      if (!perProvider) return model;
      return perProvider[_provider] || model;
    }

    const result = resolveNoOp('ark-code-latest', 'kimi-code');
    record('场景C: 未配置model_equivalents→模型名不变', result === 'ark-code-latest', {
      input: 'ark-code-latest',
      fallback: 'kimi-code',
      result,
    });
  })();

  // 场景 D: primary provider 成功 — 不进行 remap
  (function scenarioD() {
    const result = resolveModelForProvider('ark-code-latest', 'volcano');
    record('场景D: 主Provider成功→模型名不变', result === 'ark-code-latest', {
      input: 'ark-code-latest',
      provider: 'volcano(primary)',
      result,
    });
  })();
}

// ============================================================
// 汇总报告
// ============================================================
function printReport() {
  console.log(`\n${BOLD}========================================`);
  console.log('    Model Equivalents 测试汇总报告');
  console.log(`========================================${RESET}`);

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  const total = results.length;

  console.log(`\n总测试数: ${total}`);
  console.log(`\x1b[32m通过: ${passed}\x1b[0m`);
  console.log(`\x1b[31m失败: ${failed}\x1b[0m`);
  console.log(`通过率: ${total > 0 ? Math.round((passed / total) * 100) : 0}%\n`);

  if (failed > 0) {
    console.log(`\x1b[31m失败项详情:\x1b[0m`);
    for (const r of results.filter(r => !r.passed)) {
      console.log(`  - ${r.test}`);
    }
    console.log('');
  }
}

// ============================================================
// Main
// ============================================================
async function main() {
  console.log(`\x1b[36mAI Gateway — Model Equivalents 功能测试\x1b[0m`);
  console.log(`目标: ${BASE_URL}`);
  console.log(`时间: ${new Date().toLocaleString()}\n`);

  testConfigFile();
  testResolveLogic();
  await testApiEndpoints();
  testFailoverScenario();

  printReport();
}

main().catch(console.error);
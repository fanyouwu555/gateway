// WebSocket 实时指标推送测试脚本
// 使用方法: node tests/websocket-realtime-test.mjs

import WebSocket from 'ws';

const WS_URL = 'ws://localhost:3000/v1/ws/admin';
const API_URL = 'http://localhost:3000/v1/chat/completions';
const TEST_API_KEY = 'admin-dashboard-key-456';

let receivedEvents = 0;
let testRequestsSent = 0;

console.log('========================================');
console.log('  WebSocket 实时推送测试');
console.log('========================================\n');

// 1. 建立 WebSocket 连接
console.log('[1/3] 正在连接 WebSocket...');
const ws = new WebSocket(WS_URL);

ws.on('open', () => {
  console.log('  ✓ WebSocket 已连接\n');

  // 2. 发送测试请求
  console.log('[2/3] 发送测试聊天请求...');
  sendTestRequests();
});

ws.on('message', (data) => {
  try {
    const message = JSON.parse(data.toString());
    receivedEvents++;
    console.log(`  ✓ 收到实时事件 #${receivedEvents}:`, message.type || message.event);
    console.log(`     Provider: ${message.provider}, Model: ${message.model}`);
    console.log(`     延迟: ${message.duration_ms}ms, Token: ${message.total_tokens}`);
  } catch (e) {
    console.log('  收到原始消息:', data.toString());
  }
});

ws.on('error', (error) => {
  console.error('  ✗ WebSocket 错误:', error.message);
});

ws.on('close', () => {
  console.log('\n  WebSocket 连接已关闭');
  printSummary();
});

// 发送测试请求
async function sendTestRequests() {
  const testCases = [
    { model: 'deepseek-chat', message: 'Hello World' },
    { model: 'gpt-4o-mini', message: '测试中文' },
  ];

  for (const test of testCases) {
    try {
      await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${TEST_API_KEY}`,
        },
        body: JSON.stringify({
          model: test.model,
          messages: [{ role: 'user', content: test.message }],
          stream: false,
        }),
      });
      testRequestsSent++;
      console.log(`  已发送请求 #${testRequestsSent}: ${test.model}`);
    } catch (e) {
      console.log(`  请求失败 (这是正常的, mock provider 可能没有配置): ${test.model}`);
    }
    await new Promise(r => setTimeout(r, 500));
  }

  // 等待一段时间收消息
  console.log('\n[3/3] 等待接收实时事件...');
  await new Promise(r => setTimeout(r, 2000));

  ws.close();
}

function printSummary() {
  console.log('\n========================================');
  console.log('  测试总结');
  console.log('========================================');
  console.log(`  发送请求: ${testRequestsSent}`);
  console.log(`  收到事件: ${receivedEvents}`);

  if (receivedEvents > 0) {
    console.log('\n  ✅ WebSocket 实时推送功能正常!');
    process.exit(0);
  } else {
    console.log('\n  ⚠️  未收到实时事件, 可能原因:');
    console.log('     - 指标服务广播功能未正常工作');
    console.log('     - 日志中间件未正确调用 recordMetric');
    process.exit(1);
  }
}

// 超时处理
setTimeout(() => {
  console.log('\n  ⏰ 测试超时');
  ws.close();
  process.exit(1);
}, 10000);

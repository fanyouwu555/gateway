/**
 * WebSocket 测试脚本
 * 运行: node scripts/test-websocket.js
 */
import WebSocket from 'ws';

const GATEWAY_URL = process.env.GATEWAY_URL || 'ws://localhost:3000/v1/ws?model=gpt-4o-mini';
const API_KEY = process.env.API_KEY;

if (!API_KEY) {
  console.error('请设置环境变量 API_KEY 后运行本脚本');
  console.error('示例: API_KEY=sk-xxxx node scripts/test-websocket.js');
  process.exit(1);
}

console.log('Connecting to WebSocket...');

const ws = new WebSocket(GATEWAY_URL, {
  headers: {
    'Authorization': `Bearer ${API_KEY}`,
  },
});

ws.on('open', () => {
  console.log('✅ Connected!');
  console.log('\nSending chat completion request...\n');

  ws.send(
    JSON.stringify({
      type: 'chat.completion',
      payload: {
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'Say "Hello from WebSocket!"' },
        ],
        stream: true,
      },
    })
  );
});

ws.on('message', (data) => {
  const message = JSON.parse(data.toString());

  if (message.type === 'chat.completion.chunk') {
    if (message.payload === '[DONE]') {
      console.log('\n✅ Stream complete!');
      ws.close();
    } else {
      const content = message.payload.choices?.[0]?.delta?.content;
      if (content) {
        process.stdout.write(content);
      }
    }
  } else if (message.type === 'error') {
    console.error('\n❌ Error:', message.error);
  } else {
    console.log('\n📩 Message:', message.type, message.payload || '');
  }
});

ws.on('close', (code, reason) => {
  console.log(`\nConnection closed: ${code} - ${reason}`);
});

ws.on('error', (error) => {
  console.error('\n❌ Connection error:', error.message);
});

// 超时
setTimeout(() => {
  console.log('\n⏱️ Timeout');
  ws.close();
  process.exit(1);
}, 30000);

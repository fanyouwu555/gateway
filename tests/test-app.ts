/**
 * 测试用应用入口
 * 用于集成测试
 */
import { Hono } from 'hono';

// 创建一个简化的测试应用
export const app = new Hono();

app.get('/health', (c) => c.json({ status: 'ok' }));
app.get('/v1/models', (c) => c.json({ object: 'list', data: [] }));

// 添加更多测试路由...

export default app;
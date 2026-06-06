/**
 * 测试设置
 */
beforeAll(() => {
  // 设置测试环境变量
  process.env.NODE_ENV = 'test';
  process.env.PORT = '3000';
  process.env.LOG_LEVEL = 'error'; // 减少测试日志
});

// 清理mock
afterEach(() => {
  jest.clearAllMocks();
});
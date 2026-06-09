import { writeLog } from '../../src/utils/logger';

describe('Log Sampling', () => {
  const originalEnv = process.env.LOG_SAMPLE_RATE;
  const originalLogLevel = process.env.LOG_LEVEL;
  let logs: string[] = [];
  const originalConsoleLog = console.log;

  beforeEach(() => {
    logs = [];
    process.env.LOG_LEVEL = 'debug';
    console.log = (...args: unknown[]) => {
      logs.push(args.join(' '));
    };
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    if (originalEnv === undefined) {
      delete process.env.LOG_SAMPLE_RATE;
    } else {
      process.env.LOG_SAMPLE_RATE = originalEnv;
    }
    if (originalLogLevel === undefined) {
      delete process.env.LOG_LEVEL;
    } else {
      process.env.LOG_LEVEL = originalLogLevel;
    }
  });

  it('should drop info logs when sample rate is 0', () => {
    process.env.LOG_SAMPLE_RATE = '0';
    writeLog('info', 'test message');
    expect(logs).toHaveLength(0);
  });

  it('should always keep error logs regardless of sample rate', () => {
    process.env.LOG_SAMPLE_RATE = '0';
    writeLog('error', 'error message');
    expect(logs.length).toBeGreaterThan(0);
  });

  it('should keep all logs when sample rate is 1', () => {
    process.env.LOG_SAMPLE_RATE = '1';
    writeLog('info', 'test message 1');
    writeLog('info', 'test message 2');
    expect(logs).toHaveLength(2);
  });
});

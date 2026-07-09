/**
 * Logger file persistence tests
 * Verify log file writing, daily rotation, and retention cleanup
 */
import * as fs from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeLog } from '../../src/utils/logger';

describe('Logger file persistence', () => {
  let tmpDir: string;
  const originalLogDir = process.env.LOG_DIR;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalLogLevel = process.env.LOG_LEVEL;
  const originalSampleRate = process.env.LOG_SAMPLE_RATE;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(join(tmpdir(), 'gateway-logger-test-'));
    process.env.LOG_DIR = tmpDir;
    process.env.NODE_ENV = 'test';
    delete process.env.LOG_LEVEL;
    delete process.env.LOG_SAMPLE_RATE;
  });

  afterEach(() => {
    if (originalLogDir !== undefined) {
      process.env.LOG_DIR = originalLogDir;
    } else {
      delete process.env.LOG_DIR;
    }
    process.env.NODE_ENV = originalNodeEnv;
    if (originalLogLevel !== undefined) {
      process.env.LOG_LEVEL = originalLogLevel;
    } else {
      delete process.env.LOG_LEVEL;
    }
    if (originalSampleRate !== undefined) {
      process.env.LOG_SAMPLE_RATE = originalSampleRate;
    } else {
      delete process.env.LOG_SAMPLE_RATE;
    }

    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should write structured JSON log to file', () => {
    writeLog('info', 'test message', { request_id: 'req-123' });

    const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.log'));
    expect(files.length).toBe(1);

    const content = fs.readFileSync(join(tmpDir, files[0]), 'utf-8');
    const lines = content.trim().split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBe(1);

    const entry = JSON.parse(lines[0]);
    expect(entry.level).toBe('INFO');
    expect(entry.message).toBe('test message');
    expect(entry.request_id).toBe('req-123');
    expect(entry.timestamp).toBeDefined();
  });

  it('should append multiple logs to the same daily file', () => {
    writeLog('info', 'first');
    writeLog('warn', 'second');

    const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.log'));
    expect(files.length).toBe(1);

    const content = fs.readFileSync(join(tmpDir, files[0]), 'utf-8');
    const lines = content.trim().split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBe(2);

    const entry1 = JSON.parse(lines[0]);
    const entry2 = JSON.parse(lines[1]);
    expect(entry1.message).toBe('first');
    expect(entry2.message).toBe('second');
  });

  it('should create log directory if it does not exist', () => {
    const nestedDir = join(tmpDir, 'nested', 'logs');
    process.env.LOG_DIR = nestedDir;

    expect(fs.existsSync(nestedDir)).toBe(false);
    writeLog('info', 'directory test');
    expect(fs.existsSync(nestedDir)).toBe(true);

    const files = fs.readdirSync(nestedDir).filter((f) => f.endsWith('.log'));
    expect(files.length).toBe(1);
  });

  it('should clean up old log files on module load', () => {
    // Create an old log file (8 days ago)
    const oldFile = join(tmpDir, 'ai-gateway-2000-01-01.log');
    fs.writeFileSync(oldFile, 'old log\n');
    const oldTime = Date.now() - 8 * 24 * 60 * 60 * 1000;
    fs.utimesSync(oldFile, oldTime / 1000, oldTime / 1000);

    // Create a recent log file (today)
    const today = new Date().toISOString().slice(0, 10);
    const recentFile = join(tmpDir, `ai-gateway-${today}.log`);
    fs.writeFileSync(recentFile, 'recent log\n');

    // Re-require logger to trigger cleanOldLogs with current LOG_DIR
    jest.resetModules();
    require('../../src/utils/logger');

    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(recentFile)).toBe(true);
  });

  it('should skip non-gateway files during cleanup', () => {
    const otherFile = join(tmpDir, 'other-app.log');
    fs.writeFileSync(otherFile, 'other\n');
    const oldTime = Date.now() - 8 * 24 * 60 * 60 * 1000;
    fs.utimesSync(otherFile, oldTime / 1000, oldTime / 1000);

    jest.resetModules();
    require('../../src/utils/logger');

    expect(fs.existsSync(otherFile)).toBe(true);
  });

  it('should not throw when log directory is missing during cleanup', () => {
    const missingDir = join(tmpDir, 'missing');
    process.env.LOG_DIR = missingDir;

    expect(() => {
      jest.resetModules();
      require('../../src/utils/logger');
    }).not.toThrow();
  });
});

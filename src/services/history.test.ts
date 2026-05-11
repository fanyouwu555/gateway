/**
 * 对话历史服务测试
 */
import {
  createSession,
  getSession,
  addUserMessage,
  addAssistantMessage,
  getHistory,
  clearSession,
  getSessionStats,
} from '../services/history';

describe('History Service', () => {
  describe('createSession', () => {
    it('should create a new session', () => {
      const sessionId = createSession('tenant-1');
      expect(sessionId).toMatch(/^session_/);
    });

    it('should accept metadata', () => {
      const sessionId = createSession('tenant-1', { source: 'web' });
      expect(sessionId).toBeDefined();
    });
  });

  describe('getSession', () => {
    it('should return session if exists', () => {
      const sessionId = createSession('tenant-1');
      const session = getSession(sessionId);
      expect(session).not.toBeNull();
      expect(session?.id).toBe(sessionId);
    });

    it('should return null for non-existent session', () => {
      const session = getSession('non-existent');
      expect(session).toBeNull();
    });
  });

  describe('addUserMessage & addAssistantMessage', () => {
    it('should add user message to session', () => {
      const sessionId = createSession('tenant-1');
      const messages = addUserMessage(sessionId, 'Hello');

      expect(messages).not.toBeNull();
      expect(messages).toHaveLength(1);
      expect(messages?.[0].role).toBe('user');
      expect(messages?.[0].content).toBe('Hello');
    });

    it('should add assistant message to session', () => {
      const sessionId = createSession('tenant-1');
      addUserMessage(sessionId, 'Hello');
      const messages = addAssistantMessage(sessionId, 'Hi there');

      expect(messages).toHaveLength(2);
      expect(messages?.[1].role).toBe('assistant');
    });

    it('should return null for non-existent session', () => {
      const messages = addUserMessage('non-existent', 'Hello');
      expect(messages).toBeNull();
    });
  });

  describe('getHistory', () => {
    it('should return all messages by default', () => {
      const sessionId = createSession('tenant-1');
      addUserMessage(sessionId, 'Hello');
      addAssistantMessage(sessionId, 'Hi');
      addUserMessage(sessionId, 'How are you?');

      const history = getHistory(sessionId);
      expect(history).toHaveLength(3);
    });

    it('should respect limit', () => {
      const sessionId = createSession('tenant-1');
      addUserMessage(sessionId, 'Hello');
      addAssistantMessage(sessionId, 'Hi');
      addUserMessage(sessionId, 'How are you?');

      const history = getHistory(sessionId, 2);
      expect(history).toHaveLength(2);
    });
  });

  describe('clearSession', () => {
    it('should clear session', () => {
      const sessionId = createSession('tenant-1');
      addUserMessage(sessionId, 'Hello');

      const deleted = clearSession(sessionId);
      expect(deleted).toBe(true);

      const session = getSession(sessionId);
      expect(session).toBeNull();
    });
  });

  describe('getSessionStats', () => {
    it('should return statistics', () => {
      const stats = getSessionStats();
      expect(stats).toHaveProperty('total_sessions');
      expect(stats).toHaveProperty('total_messages');
      expect(stats).toHaveProperty('by_tenant');
    });
  });
});
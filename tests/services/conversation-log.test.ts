import { ConversationLogService } from '../../src/services/conversation-log';
import type { IConversationTurn, ISessionMeta } from '../../src/types';

describe('ConversationLogService', () => {
  let service: ConversationLogService;

  beforeEach(() => {
    service = new ConversationLogService({ enabled: true, maxMemorySessions: 10, redisTtlDays: 1, maxTurnsPerSession: 100 });
  });

  afterEach(async () => {
    await service.clearAll();
  });

  describe('saveTurn', () => {
    it('should save a turn and retrieve it', async () => {
      const turn: IConversationTurn = {
        turn_id: 'turn_1',
        session_id: 'sess_123',
        timestamp: Date.now(),
        request: { messages: [{ role: 'user', content: 'Hello' }], model: 'gpt-4o' },
        response: { content: 'Hi there', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
        metadata: { provider: 'openai', duration_ms: 100, cost: 0.001, status_code: 200 },
      };

      await service.saveTurn(turn);
      const turns = await service.getSessionTurns('sess_123');

      expect(turns).toHaveLength(1);
      expect(turns[0].turn_id).toBe('turn_1');
      expect(turns[0].response.content).toBe('Hi there');
    });

    it('should aggregate session metadata', async () => {
      const turn1: IConversationTurn = {
        turn_id: 'turn_1',
        session_id: 'sess_abc',
        timestamp: Date.now(),
        request: { messages: [{ role: 'user', content: 'Q1' }], model: 'gpt-4o' },
        response: { content: 'A1', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
        metadata: { provider: 'openai', duration_ms: 100, cost: 0.001, status_code: 200 },
      };
      const turn2: IConversationTurn = {
        turn_id: 'turn_2',
        session_id: 'sess_abc',
        timestamp: Date.now() + 1,
        request: { messages: [{ role: 'user', content: 'Q2' }], model: 'gpt-4o' },
        response: { content: 'A2', usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } },
        metadata: { provider: 'openai', duration_ms: 80, cost: 0.0008, status_code: 200 },
      };

      await service.saveTurn(turn1);
      await service.saveTurn(turn2);
      const meta = await service.getSessionMeta('sess_abc');

      expect(meta).not.toBeNull();
      expect(meta!.turn_count).toBe(2);
      expect(meta!.total_tokens).toBe(27);
      expect(meta!.total_cost).toBeCloseTo(0.0018, 4);
    });

    it('should return empty array for unknown session', async () => {
      const turns = await service.getSessionTurns('unknown');
      expect(turns).toEqual([]);
    });

    it('should not throw when saving disabled', async () => {
      const disabledService = new ConversationLogService({ enabled: false });
      const turn: IConversationTurn = {
        turn_id: 'turn_1',
        session_id: 'sess_disabled',
        timestamp: Date.now(),
        request: { messages: [{ role: 'user', content: 'Hello' }], model: 'gpt-4o' },
        response: { content: 'Hi', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
        metadata: { provider: 'openai', duration_ms: 10, cost: 0, status_code: 200 },
      };
      await expect(disabledService.saveTurn(turn)).resolves.not.toThrow();
      const turns = await disabledService.getSessionTurns('sess_disabled');
      expect(turns).toEqual([]);
    });

    it('should return null meta for unknown session', async () => {
      const meta = await service.getSessionMeta('totally-unknown');
      expect(meta).toBeNull();
    });
  });

  describe('listSessions', () => {
    it('should list sessions with metadata', async () => {
      const turn: IConversationTurn = {
        turn_id: 'turn_1',
        session_id: 'sess_list',
        timestamp: Date.now(),
        request: { messages: [{ role: 'user', content: 'Hello' }], model: 'gpt-4o' },
        response: { content: 'Hi', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
        metadata: { provider: 'openai', duration_ms: 10, cost: 0, status_code: 200 },
      };
      await service.saveTurn(turn);

      const result = await service.listSessions({});
      expect(result.total).toBeGreaterThanOrEqual(1);
      expect(result.sessions.some((s: ISessionMeta) => s.session_id === 'sess_list')).toBe(true);
    });
  });

  describe('deleteSession', () => {
    it('should delete a session', async () => {
      const turn: IConversationTurn = {
        turn_id: 'turn_1',
        session_id: 'sess_del',
        timestamp: Date.now(),
        request: { messages: [{ role: 'user', content: 'Hello' }], model: 'gpt-4o' },
        response: { content: 'Hi', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
        metadata: { provider: 'openai', duration_ms: 10, cost: 0, status_code: 200 },
      };
      await service.saveTurn(turn);
      expect(await service.getSessionMeta('sess_del')).not.toBeNull();

      await service.deleteSession('sess_del');
      expect(await service.getSessionMeta('sess_del')).toBeNull();
      expect(await service.getSessionTurns('sess_del')).toEqual([]);
    });
  });

  describe('clearAll', () => {
    it('should remove all sessions', async () => {
      const turn: IConversationTurn = {
        turn_id: 'turn_1',
        session_id: 'sess_clear',
        timestamp: Date.now(),
        request: { messages: [{ role: 'user', content: 'Hello' }], model: 'gpt-4o' },
        response: { content: 'Hi', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
        metadata: { provider: 'openai', duration_ms: 10, cost: 0, status_code: 200 },
      };
      await service.saveTurn(turn);
      expect(await service.getSessionMeta('sess_clear')).not.toBeNull();

      await service.clearAll();
      expect(await service.getSessionMeta('sess_clear')).toBeNull();
      expect(await service.getSessionTurns('sess_clear')).toEqual([]);
    });
  });

  describe('listSessions filtering', () => {
    it('should filter by time range', async () => {
      const now = Date.now();
      const turn1: IConversationTurn = {
        turn_id: 'turn_1',
        session_id: 'sess_old',
        timestamp: now - 10000,
        request: { messages: [{ role: 'user', content: 'Old' }], model: 'gpt-4o' },
        response: { content: 'A', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
        metadata: { provider: 'openai', duration_ms: 10, cost: 0, status_code: 200 },
      };
      const turn2: IConversationTurn = {
        turn_id: 'turn_1',
        session_id: 'sess_new',
        timestamp: now,
        request: { messages: [{ role: 'user', content: 'New' }], model: 'gpt-4o' },
        response: { content: 'B', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
        metadata: { provider: 'openai', duration_ms: 10, cost: 0, status_code: 200 },
      };
      await service.saveTurn(turn1);
      await service.saveTurn(turn2);

      const result = await service.listSessions({ start: now - 5000 });
      expect(result.sessions.some((s) => s.session_id === 'sess_new')).toBe(true);
      expect(result.sessions.some((s) => s.session_id === 'sess_old')).toBe(false);
    });
  });
});

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { getDb, migrate } from '@/lib/db/client';
import { sessions } from '@/lib/db/schema';

const mockSession = {
  send: vi.fn().mockResolvedValue(undefined),
  stream: vi.fn().mockReturnValue({
    async *[Symbol.asyncIterator]() {
      yield { type: 'message.appended', data: { delta: 'Hello' } };
      yield { type: 'turn.completed', data: { finishReason: 'stop' } };
    },
  }),
};

const mockClientInstance = {
  info: vi.fn().mockResolvedValue({ model: { id: 'claude-sonnet-4.6' } }),
  session: vi.fn().mockResolvedValue(mockSession),
};

vi.mock('eve/client', () => {
  return {
    Client: vi.fn().mockImplementation(function () {
      return mockClientInstance;
    }),
  };
});

let EveagentBackend: typeof import('@/lib/backends/eveagent').EveagentBackend;

beforeEach(async () => {
  vi.resetModules();
  process.env.DATABASE_URL = 'file::memory:?cache=shared';
  await migrate();
  const mod = await import('@/lib/backends/eveagent');
  EveagentBackend = mod.EveagentBackend;
  vi.clearAllMocks();
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe('EveagentBackend', () => {
  it('续接路径：DB 已有 eveSessionId/eveContinuationToken', async () => {
    const backend = new EveagentBackend();
    const db = getDb();
    const sessionId = 'test-session-1';
    await db.insert(sessions).values({
      id: sessionId,
      backend: 'eveagent',
      model: 'claude-sonnet-4.6',
      eveSessionId: 'eve-session-123',
      eveContinuationToken: 'token-456',
      createdAt: new Date(),
      lastActiveAt: new Date(),
    });

    await backend.startSession({
      sessionId,
      model: 'claude-sonnet-4.6',
      history: [],
    });

    expect(mockClientInstance.session).toHaveBeenCalledWith({
      sessionId: 'eve-session-123',
      continuationToken: 'token-456',
      streamIndex: 0,
    });
  });

  it('重建路径：DB 有 eveSessionId 但 eve 报 not-found', async () => {
    mockClientInstance.session.mockRejectedValueOnce(new Error('session-not-found'));

    const backend = new EveagentBackend();
    const db = getDb();
    const sessionId = 'test-session-2';
    await db.insert(sessions).values({
      id: sessionId,
      backend: 'eveagent',
      model: 'claude-sonnet-4.6',
      eveSessionId: 'eve-session-not-found',
      eveContinuationToken: 'token-789',
      createdAt: new Date(),
      lastActiveAt: new Date(),
    });

    await backend.startSession({
      sessionId,
      model: 'claude-sonnet-4.6',
      history: [{ role: 'user', content: 'previous message' }],
    });

    expect(mockClientInstance.session).toHaveBeenCalledTimes(2);
    expect(mockClientInstance.session).toHaveBeenLastCalledWith();
  });
});
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { getDb, migrate } from '@/lib/db/client';
import { sessions, messages } from '@/lib/db/schema';

// Mock eve/client for EveagentBackend
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

vi.mock('eve/client', () => ({
  Client: vi.fn().mockImplementation(function () {
    return mockClientInstance;
  }),
}));

// Mock NextRequest/NextResponse for route testing
// We'll use fetch against a running dev server or mock the route handlers directly

beforeEach(async () => {
  process.env.DATABASE_URL = 'file::memory:?cache=shared';
  await migrate();
  vi.clearAllMocks();
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe('POST /api/sessions', () => {
  it('创建 eveagent session 返回 201', async () => {
    // 由于 Next.js App Router 路由难以直接单元测试
    // 这里通过直接调用路由处理器的逻辑来验证
    // 实际运行时通过 pnpm dev + curl 验证
    const { POST } = await import('@/app/api/sessions/route');
    const request = new Request('http://localhost:3000/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backend: 'eveagent', model: 'claude-sonnet-4.6' }),
    });
    const response = await POST(request as any);
    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.backend).toBe('eveagent');
    expect(data.model).toBe('claude-sonnet-4.6');
    expect(data.id).toBeDefined();

    // 验证数据库
    const db = getDb();
    const [session] = await db.select().from(sessions).where(eq(sessions.id, data.id)).limit(1);
    expect(session).toBeDefined();
  });
});

import { eq } from 'drizzle-orm';
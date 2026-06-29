import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { getDb, migrate, resetDb } from '@/lib/db/client';

beforeEach(async () => {
  process.env.DATABASE_URL = 'file::memory:?cache=shared';
  await migrate();
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe('POST /api/setup-tokens', () => {
  it('生成 setup token 返回 201', async () => {
    const { POST } = await import('@/app/api/setup-tokens/route');
    const request = new Request('http://localhost:3000/api/setup-tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceName: 'test-device' }),
    });
    const response = await POST(request as any);
    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.setupToken).toBeDefined();
    expect(data.expiresAt).toBeDefined();
    expect(data.command).toContain('webtool-client register');
  });
});
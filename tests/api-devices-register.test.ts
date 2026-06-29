import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { getDb, migrate } from '@/lib/db/client';
import { setupTokens } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

beforeEach(async () => {
  process.env.DATABASE_URL = 'file::memory:?cache=shared';
  await migrate();
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe('POST /api/devices/register', () => {
  it('setup token 注册成功', async () => {
    // 先创建一个 setup token
    const { POST: createToken } = await import('@/app/api/setup-tokens/route');
    const createRequest = new Request('http://localhost:3000/api/setup-tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceName: 'test-device' }),
    });
    const createResponse = await createToken(createRequest as any);
    const { setupToken } = await createResponse.json();

    // 使用 setup token 注册
    const { POST: register } = await import('@/app/api/devices/register/route');
    const registerRequest = new Request('http://localhost:3000/api/devices/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ setupToken, hostname: 'localhost', supportedBackends: ['claudecode'] }),
    });
    const registerResponse = await register(registerRequest as any);
    expect(registerResponse.status).toBe(201);
    const data = await registerResponse.json();
    expect(data.deviceId).toBeDefined();
    expect(data.longLivedToken).toBeDefined();
  });
});
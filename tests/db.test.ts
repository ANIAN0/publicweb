import { describe, it, expect, beforeAll } from 'vitest';
import { migrate, getDb } from '@/lib/db/client';

beforeAll(async () => {
  process.env.DATABASE_URL = 'file::memory:?cache=shared';
  await migrate();
});

describe('DB schema', () => {
  it('6 张表都存在', async () => {
    const db = getDb();
    const tables = await db.all<{name:string}>(`SELECT name FROM sqlite_master WHERE type='table'`);
    const expected = ['devices','device_supported_backends','device_models','setup_tokens','sessions','messages'];
    for (const t of expected) expect(tables.map(x=>x.name)).toContain(t);
  });
});
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, stopTestServer } from './helpers/server';
import WebSocket from 'ws';

describe('WS gateway', () => {
  let wsUrl: string;
  let longLivedToken: string;
  let httpUrl: string;

  beforeAll(async () => {
    const ctx = await startTestServer();
    wsUrl = ctx.wsUrl;
    longLivedToken = ctx.longLivedToken;
    httpUrl = ctx.httpUrl;
  });

  afterAll(() => {
    stopTestServer();
  });

  it('upgrade 鉴权失败', async () => {
    const ws = new WebSocket(`${wsUrl}?token=invalid`);
    await expect(new Promise((res, rej) => {
      ws.on('close', code => res(code));
      ws.on('error', () => res(1008));
    })).resolves.toBeGreaterThanOrEqual(1000);
  });

  it('device.hello 写表', async () => {
    const ws = new WebSocket(`${wsUrl}?token=${longLivedToken}`);
    await new Promise(res => ws.on('open', res));
    ws.send(JSON.stringify({ type: 'device.hello', name: 'workstation', supportedBackends: ['claudecode'] }));
    await new Promise(r => setTimeout(r, 100));
    const { getDb } = await import('@/lib/db/client');
    const db = getDb();
    const rows = await db.all('SELECT backend FROM device_supported_backends');
    expect(rows.map((r: any) => r.backend)).toContain('claudecode');
    ws.close();
  });
});
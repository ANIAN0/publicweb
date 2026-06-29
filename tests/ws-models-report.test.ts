import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, stopTestServer } from './helpers/server';
import WebSocket from 'ws';

describe('WS models.report', () => {
  let wsUrl: string;
  let longLivedToken: string;
  let deviceId: string;

  beforeAll(async () => {
    const ctx = await startTestServer();
    wsUrl = ctx.wsUrl;
    longLivedToken = ctx.longLivedToken;
    deviceId = ctx.deviceId;
  });

  afterAll(() => {
    stopTestServer();
  });

  it('models.report 写入 device_models 表', async () => {
    const ws = new WebSocket(`${wsUrl}?token=${longLivedToken}`);
    await new Promise(res => ws.on('open', res));
    
    // 先发送 device.hello
    ws.send(JSON.stringify({ type: 'device.hello', name: 'test', supportedBackends: ['claudecode'] }));
    await new Promise(r => setTimeout(r, 100));
    
    // 发送 models.report
    ws.send(JSON.stringify({
      type: 'models.report',
      backend: 'claudecode',
      models: [
        { id: 'claude-sonnet-4.6', label: 'Claude Sonnet 4.6', isDefault: true },
        { id: 'claude-haiku-3.5', label: 'Claude Haiku 3.5' },
      ],
    }));
    await new Promise(r => setTimeout(r, 100));
    
    const { getDb } = await import('@/lib/db/client');
    const db = getDb();
    const rows = await db.all('SELECT backend, models_json FROM device_models');
    expect(rows.length).toBe(1);
    expect(rows[0].backend).toBe('claudecode');
    const models = JSON.parse(rows[0].models_json);
    expect(models.length).toBe(2);
    expect(models[0].id).toBe('claude-sonnet-4.6');
    
    ws.close();
  });
});
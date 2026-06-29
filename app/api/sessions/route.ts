import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';
import { sessions } from '@/lib/db/schema';
import { ulid } from 'ulid';
import { getBackendAdapter } from '@/lib/backends/router';

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { backend, model, deviceId } = body;

  if (!backend || !model) {
    return NextResponse.json({ error: 'backend and model are required' }, { status: 400 });
  }

  const id = ulid();
  const now = new Date();
  const db = getDb();

  // 创建 session 记录
  await db.insert(sessions).values({
    id,
    backend,
    model,
    deviceId: deviceId || null,
    createdAt: now,
    lastActiveAt: now,
  });

  // 如果是 eveagent，异步启动 session（不阻塞响应）
  if (backend === 'eveagent') {
    const adapter = getBackendAdapter('eveagent');
    // 后台启动，不等待
    adapter.startSession({ sessionId: id, model, history: [] }).catch(console.error);
  }

  return NextResponse.json({ id, backend, model, lastActiveAt: now }, { status: 201 });
}

export async function GET() {
  const db = getDb();
  const allSessions = await db.select().from(sessions);
  return NextResponse.json(allSessions);
}
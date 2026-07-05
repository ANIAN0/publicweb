import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';
import { sessions, devices, deviceSupportedBackends, messages } from '@/lib/db/schema';
import { ulid } from 'ulid';
import { eq, and, isNull, like, or, desc, inArray, sql } from 'drizzle-orm';
import { getBackendAdapter } from '@/lib/backends/router';

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { backend, model, deviceId } = body;

  if (!backend || !model) {
    return NextResponse.json({ error: 'backend and model are required' }, { status: 400 });
  }

  // 本地后端（claudecode / pi）需要 deviceId 在线 + 支持该后端
  if ((backend === 'claudecode' || backend === 'pi') && !deviceId) {
    return NextResponse.json({ error: 'deviceId is required for local backends' }, { status: 400 });
  }

  if (backend === 'claudecode' || backend === 'pi') {
    const db = await getDb();
    const [device] = await db.select().from(devices).where(eq(devices.id, deviceId)).limit(1);
    if (!device) {
      return NextResponse.json({ error: 'device not found' }, { status: 404 });
    }
    if (!device.online) {
      return NextResponse.json({ error: 'device offline' }, { status: 400 });
    }
    const [supported] = await db.select().from(deviceSupportedBackends)
      .where(and(eq(deviceSupportedBackends.deviceId, deviceId), eq(deviceSupportedBackends.backend, backend)))
      .limit(1);
    if (!supported) {
      return NextResponse.json({ error: `device does not support backend: ${backend}` }, { status: 400 });
    }
  }

  const id = ulid();
  const now = new Date();
  const db = await getDb();

  // 创建 session 记录
  await db.insert(sessions).values({
    id,
    backend,
    model,
    deviceId: deviceId || null,
    createdAt: now,
    lastActiveAt: now,
  });

  // 启动 session：eveagent 调远程；claudecode/pi 调 LocalBackend.startSession
  const adapter = getBackendAdapter(backend);
  adapter.startSession({
    sessionId: id,
    model,
    history: [],
    ...(deviceId ? { deviceId } : {}),
    ...(backend === 'claudecode' || backend === 'pi' ? { backend } : {}),
  }).catch(console.error);

  return NextResponse.json({ id, backend, model, deviceId: deviceId || null, lastActiveAt: now }, { status: 201 });
}

export async function GET(request: NextRequest) {
  const db = await getDb();
  // 用 URL 解析 searchParams（兼容 web Request 与 NextRequest；request.nextUrl 仅在 NextRequest 存在）
  const params = new URL(request.url).searchParams;

  // 解析筛选参数
  const backend = params.get('backend');                            // 'eveagent' | 'claudecode' | 'pi'
  const q = params.get('q');                                        // 标题/userTitle 模糊匹配
  const limit = Math.min(parseInt(params.get('limit') ?? '50', 10) || 50, 200);
  const offset = Math.max(parseInt(params.get('offset') ?? '0', 10) || 0, 0);

  // 构建 WHERE：未删除 + 可选 backend 过滤 + 可选 q 模糊匹配（命中 title 或 userTitle）
  const conditions = [isNull(sessions.deletedAt)];
  if (backend) conditions.push(eq(sessions.backend, backend));
  if (q) {
    const pattern = `%${q}%`;
    conditions.push(or(like(sessions.title, pattern), like(sessions.userTitle, pattern))!);
  }

  // 查 sessions（按 lastActiveAt desc，应用 limit/offset）
  const sessionRows = await db.select().from(sessions)
    .where(and(...conditions))
    .orderBy(desc(sessions.lastActiveAt))
    .limit(limit)
    .offset(offset);

  if (sessionRows.length === 0) {
    return NextResponse.json([]);
  }

  // JOIN devices 拿 deviceName（按 deviceId 批量查）
  const deviceIds = sessionRows.map((s) => s.deviceId).filter((id): id is string => id !== null);
  const deviceRows = deviceIds.length > 0
    ? await db.select({ id: devices.id, name: devices.name }).from(devices).where(inArray(devices.id, deviceIds))
    : [];
  const deviceNameById = new Map(deviceRows.map((d) => [d.id, d.name]));

  // JOIN messages 拿 messageCount（按 sessionId 批量聚合）
  const sessionIds = sessionRows.map((s) => s.id);
  const countRows = await db
    .select({ sessionId: messages.sessionId, count: sql<number>`count(*)`.as('count') })
    .from(messages)
    .where(inArray(messages.sessionId, sessionIds))
    .groupBy(messages.sessionId);
  const countBySessionId = new Map(countRows.map((r) => [r.sessionId, Number(r.count)]));

  // 合并返回
  const result = sessionRows.map((s) => ({
    id: s.id,
    backend: s.backend,
    model: s.model,
    title: s.title,
    userTitle: s.userTitle,
    deviceId: s.deviceId,
    deviceName: s.deviceId ? deviceNameById.get(s.deviceId) ?? null : null,
    messageCount: countBySessionId.get(s.id) ?? 0,
    createdAt: s.createdAt,
    lastActiveAt: s.lastActiveAt,
  }));

  return NextResponse.json(result);
}

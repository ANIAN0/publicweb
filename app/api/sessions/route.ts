import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';
import { sessions, devices, eveServices, messages } from '@/lib/db/schema';
import { ulid } from 'ulid';
import { eq, and, isNull, like, or, desc, inArray, sql } from 'drizzle-orm';
import { getBackendAdapter } from '@/lib/backends/router';
import { parseJsonBody } from '@/lib/api/parse-json-body';
import { z } from 'zod';

// APP-004：创建会话 body 校验
const createSessionSchema = z.object({
  backend: z.string().min(1),
  model: z.string().min(1),
  targetId: z.string().min(1),
  cwd: z.string().optional().nullable(),
});

export async function POST(request: NextRequest) {
  const parsed = await parseJsonBody(request, createSessionSchema);
  if (!parsed.ok) return parsed.response;
  const { backend, model, targetId, cwd } = parsed.data;

  // 用适配器校验 targetId:listTargets 拿该后端可用端点,确认 targetId 在其中且 online + 支持 model。
  // API 层不硬编码 backend 名,端点来源差异(设备表 vs eve 服务表)封在适配器内。
  let adapter;
  try { adapter = getBackendAdapter(backend); }
  catch { return NextResponse.json({ error: `Unsupported backend: ${backend}` }, { status: 400 }); }

  const targets = await adapter.listTargets();
  const target = targets.find((t) => t.id === targetId);
  if (!target) {
    return NextResponse.json({ error: 'target not found for this backend' }, { status: 404 });
  }
  if (!target.online) {
    return NextResponse.json({ error: 'target offline' }, { status: 400 });
  }
  // 校验 model 在 target.models 里(local:用户选的模型必须设备支持;eveagent:单模型自动匹配)
  if (!target.models.some((m) => m.id === model)) {
    return NextResponse.json({ error: `model ${model} not supported by this target` }, { status: 400 });
  }

  const id = ulid();
  const now = new Date();
  const db = await getDb();

  // 创建 session 记录 + 启动:任一失败回滚 + 500 + 打日志定位根因(AGENTS.md 第 13 条)
  // insert 失败常见于 schema 变更后未跑 migration(如 cwd 列缺失);startSession 失败常见于设备 WS 断连
  try {
    await db.insert(sessions).values({
      id,
      backend,
      model,
      targetId,
      cwd: cwd ?? null,  // 工作目录:local 子进程 cwd;null 表示用 client 运行目录
      createdAt: now,
      lastActiveAt: now,
    });
    // 启动 session:适配器内部决定对接方式(local 派发 WS 到 client,eveagent 选 host 走 HTTP)
    await adapter.startSession({ sessionId: id, model, targetId, history: [], cwd: cwd ?? undefined });
  } catch (err) {
    console.error(`[session-create] failed backend=${backend} targetId=${targetId}:`, err);
    await db.delete(sessions).where(eq(sessions.id, id)).catch(() => {});
    const message = err instanceof Error ? err.message : 'create session failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }

  return NextResponse.json({ id, backend, model, targetId, lastActiveAt: now }, { status: 201 });
}

export async function GET(request: NextRequest) {
  const db = await getDb();
  const params = new URL(request.url).searchParams;

  const backend = params.get('backend');
  const q = params.get('q');
  const limit = Math.min(parseInt(params.get('limit') ?? '50', 10) || 50, 200);
  const offset = Math.max(parseInt(params.get('offset') ?? '0', 10) || 0, 0);

  // WHERE:未删除 + 可选 backend 过滤 + 可选 q 模糊匹配(title 或 userTitle)
  const conditions = [isNull(sessions.deletedAt)];
  if (backend) conditions.push(eq(sessions.backend, backend));
  if (q) {
    const pattern = `%${q}%`;
    // APP-020：显式检查 or() 结果，避免非空断言
    const titleOrUser = or(like(sessions.title, pattern), like(sessions.userTitle, pattern));
    if (titleOrUser) conditions.push(titleOrUser);
  }

  const sessionRows = await db.select().from(sessions)
    .where(and(...conditions))
    .orderBy(desc(sessions.lastActiveAt))
    .limit(limit)
    .offset(offset);

  if (sessionRows.length === 0) {
    return NextResponse.json([]);
  }

  // 按 backend 分组 JOIN 拿 targetName:local(claudecode/pi) JOIN devices, eveagent JOIN eve_services。
  // target 多态存储(不同 backend 的 target 在不同表),按 backend 决定 JOIN 哪个表是数据访问层职责。
  const localTargetIds = sessionRows
    .filter((s) => s.backend === 'claudecode' || s.backend === 'pi')
    .map((s) => s.targetId);
  const eveTargetIds = sessionRows
    .filter((s) => s.backend === 'eveagent')
    .map((s) => s.targetId);

  const targetNameById = new Map<string, string>();
  if (localTargetIds.length > 0) {
    const deviceRows = await db.select({ id: devices.id, name: devices.name })
      .from(devices).where(inArray(devices.id, localTargetIds));
    deviceRows.forEach((d) => targetNameById.set(d.id, d.name));
  }
  if (eveTargetIds.length > 0) {
    const svcRows = await db.select({ id: eveServices.id, name: eveServices.name })
      .from(eveServices).where(inArray(eveServices.id, eveTargetIds));
    svcRows.forEach((s) => targetNameById.set(s.id, s.name));
  }

  // JOIN messages 拿 messageCount(按 sessionId 批量聚合)
  const sessionIds = sessionRows.map((s) => s.id);
  const countRows = await db
    .select({ sessionId: messages.sessionId, count: sql<number>`count(*)`.as('count') })
    .from(messages)
    .where(inArray(messages.sessionId, sessionIds))
    .groupBy(messages.sessionId);
  const countBySessionId = new Map(countRows.map((r) => [r.sessionId, Number(r.count)]));

  const result = sessionRows.map((s) => ({
    id: s.id,
    backend: s.backend,
    model: s.model,
    title: s.title,
    userTitle: s.userTitle,
    targetId: s.targetId,
    targetName: targetNameById.get(s.targetId) ?? null,
    // 已删 target 标记:true 表示 target 已被删除(用于前端展示"已删除设备/服务" + 提供清理按钮)
    targetDeleted: !targetNameById.has(s.targetId),
    messageCount: countBySessionId.get(s.id) ?? 0,
    createdAt: s.createdAt,
    lastActiveAt: s.lastActiveAt,
  }));

  return NextResponse.json(result);
}

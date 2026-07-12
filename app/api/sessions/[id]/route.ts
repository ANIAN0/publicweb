import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';
import { sessions } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { debugLog } from '@/lib/debug-log';
import { getActiveSession, getSessionById } from '@/lib/api/get-active-session';
import { releaseTurnLock } from '@/lib/backends/turn-lock';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  // GET 详情允许看已删（区分不存在）；密钥仍剥离
  const session = await getSessionById(id);
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }
  // 不向浏览器暴露续接密钥（可被枚举 sessionId 拿走）
  const {
    eveContinuationToken: _t,
    localSessionRef: _r,
    ...safe
  } = session;
  return NextResponse.json({
    ...safe,
    // 仅暴露是否存在，便于 UI/诊断，不回传明文
    hasEveContinuationToken: Boolean(session.eveContinuationToken),
    hasLocalSessionRef: Boolean(session.localSessionRef),
  });
}

// PATCH /api/sessions/[id]：仅允许更新 userTitle 字段
// 约束：body 只能包含 userTitle；空字符串视为 null（清空回退到自动 title）
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json();

  // 严格 schema：仅接受 userTitle，且必须是 string | null
  const schema = z.object({
    userTitle: z.union([z.string(), z.null()]),
  }).strict();
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'only userTitle is allowed', details: parsed.error.issues },
      { status: 400 }
    );
  }

  // 空字符串视为 null（前端清空操作的便利写法）
  const userTitle = parsed.data.userTitle === '' ? null : parsed.data.userTitle;

  // APP-001：仅未删除 session 可改标题
  const session = await getActiveSession(id);
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  const db = await getDb();
  await db.update(sessions).set({ userTitle }).where(eq(sessions.id, id));
  return NextResponse.json({ id, userTitle });
}

// DELETE /api/sessions/[id]：软删（写 deletedAt）
// 不存在的 / 已删的都返回 404，让二次确认后再次请求也有清晰反馈
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // APP-001：必须未删除才允许 DELETE
  const session = await getActiveSession(id);
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  const db = await getDb();
  await db.update(sessions).set({ deletedAt: new Date() }).where(eq(sessions.id, id));
  await releaseTurnLock(id);
  // 软删后释放 Local persist 订阅，避免会话幽灵订阅占内存
  // APP-002：保留动态 import（避循环依赖）+ debugLog；必须调用 releaseRuntime
  try {
    debugLog('app', `DELETE session releaseRuntime sid=${id} backend=${session.backend}`);
    const { getBackendAdapter } = await import('@/lib/backends/router');
    const adapter = getBackendAdapter(session.backend) as {
      releaseRuntime?: (sid: string) => void;
      stop?: (sid: string) => Promise<void>;
    };
    adapter.releaseRuntime?.(id);
    await adapter.stop?.(id);
  } catch (err) {
    debugLog(
      'app',
      `DELETE session release failed sid=${id} err=${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return NextResponse.json({ id, deletedAt: new Date().toISOString() });
}

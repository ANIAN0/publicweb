import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';
import { sessions } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getActiveSession, getSessionById } from '@/lib/api/get-active-session';
import { softDeleteSession } from '@/lib/api/soft-delete-session';
import { getBackendAdapter } from '@/lib/backends/router';
import { isLocalBackendId } from '@/lib/backends/labels';

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

  // D2: local backend 时把 target 的实时 models 一起下发，省掉 chat 页第二次 round-trip
  // （仅 claudecode/pi 有可换模型；eveagent 单模型绑死无需列表）
  let availableModels: Array<{ id: string; label: string; isDefault?: boolean }> | undefined;
  if (session.targetId && isLocalBackendId(session.backend)) {
    try {
      const adapter = getBackendAdapter(session.backend);
      const targets = await adapter.listTargets();
      const target = targets.find((item) => item.id === session.targetId);
      availableModels = target?.models;
    } catch {
      availableModels = undefined; // 后端不可用时让前端走 fallback（不阻塞 GET）
    }
  }

  return NextResponse.json({
    ...safe,
    // 仅暴露是否存在，便于 UI/诊断，不回传明文
    hasEveContinuationToken: Boolean(session.eveContinuationToken),
    hasLocalSessionRef: Boolean(session.localSessionRef),
    ...(availableModels ? { availableModels } : {}),
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

  // APP-001：与 bulk-delete 共用 softDeleteSession
  const result = await softDeleteSession(id);
  if (result === 'skipped') {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }
  return NextResponse.json({ id, deletedAt: new Date().toISOString() });
}

import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';
import { sessions } from '@/lib/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { z } from 'zod';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = await getDb();
  const [session] = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }
  return NextResponse.json(session);
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

  const db = await getDb();
  const [session] = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

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
  const db = await getDb();

  // 必须未删除才允许 DELETE（已删的视为不存在）
  const [session] = await db.select().from(sessions)
    .where(and(eq(sessions.id, id), isNull(sessions.deletedAt)))
    .limit(1);
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  await db.update(sessions).set({ deletedAt: new Date() }).where(eq(sessions.id, id));
  return NextResponse.json({ id, deletedAt: new Date().toISOString() });
}
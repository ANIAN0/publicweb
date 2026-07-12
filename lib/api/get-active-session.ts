// APP-001：查未软删 session 的公共 helper，统一 404 语义
import { getDb } from '@/lib/db/client';
import { sessions } from '@/lib/db/schema';
import { and, eq, isNull } from 'drizzle-orm';

export type ActiveSessionRow = typeof sessions.$inferSelect;

/**
 * 按 id 取未删除 session；不存在或已软删返回 null。
 */
export async function getActiveSession(id: string): Promise<ActiveSessionRow | null> {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, id), isNull(sessions.deletedAt)))
    .limit(1);
  return row ?? null;
}

/**
 * 仅按 id 取 session（含已删），用于 GET 详情等需区分「不存在」的场景。
 */
export async function getSessionById(id: string): Promise<ActiveSessionRow | null> {
  const db = await getDb();
  const [row] = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
  return row ?? null;
}

// pendingUserMessage stale 判断(共享,供 messages/route.ts GET + T-006 resume 复用)
// 独立模块避免 messages/route.ts 与 eveagent.ts 之间的循环依赖(REV-001 MEDIUM-3)
import { getDb } from '@/lib/db/client';
import { sessions, messages } from '@/lib/db/schema';
import { eq, and, gte } from 'drizzle-orm';

/**
 * 判断 session 的 pendingUserMessage 是否已 stale(过期):
 * - 无 pendingUserMessage 或 pendingUserMessageCreatedAt → false(无 pending)
 * - 有 pending → 查 messages 是否存在 createdAt>=pendingCreatedAt 且 metadata.finishReason!==undefined 的 assistant 消息
 *   (对齐 template queries.ts:142-150 getChatForUser 服务端隐藏 stale pending:finishReason!==undefined 等价 turn settled)
 *
 * stale=true 表示 pending 对应的 turn 已 settled,pending 是过期残留,应隐藏不触发 resume。
 */
export async function isPendingStale(sessionId: string): Promise<boolean> {
  const db = await getDb();
  const [session] = await db.select({
    pendingUserMessage: sessions.pendingUserMessage,
    pendingUserMessageCreatedAt: sessions.pendingUserMessageCreatedAt,
  }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  // 无 pending 或无 createdAt,不算 stale
  if (!session?.pendingUserMessage || !session.pendingUserMessageCreatedAt) {
    return false;
  }
  // 查 createdAt>=pendingCreatedAt 的 assistant 消息,看是否有 finishReason!==undefined(turn settled)
  const candidates = await db.select({ metadata: messages.metadata })
    .from(messages)
    .where(and(
      eq(messages.sessionId, sessionId),
      eq(messages.role, 'assistant'),
      gte(messages.createdAt, session.pendingUserMessageCreatedAt),
    ));
  for (const m of candidates) {
    if (!m.metadata) continue;
    try {
      const meta = JSON.parse(m.metadata);
      if (meta?.finishReason !== undefined) return true;  // 有 settled assistant,pending 已 stale
    } catch { /* 损坏 metadata 跳过 */ }
  }
  return false;
}

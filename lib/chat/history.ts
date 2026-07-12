// APP-008/009：从 DB / 消息行构造 startSession 用的 history
import { getDb } from '@/lib/db/client';
import { messages } from '@/lib/db/schema';
import { eq, and, asc, lt, lte } from 'drizzle-orm';
import { extractTextFromParts } from '@/lib/chat/parts';
import type { ChatMessage } from '@/lib/backends/types';

export type HistoryRow = { role: string; parts: string | null; seq?: number };

/**
 * 把消息行转成 agent history（仅 user/assistant，过滤空 content）。
 * fork 等已加载行的路径直接复用，避免重复查库。
 */
export function buildHistoryFromRows(rows: HistoryRow[]): ChatMessage[] {
  return rows
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: extractTextFromParts(m.parts),
    }))
    .filter((m) => m.content);
}

/**
 * 从 DB 加载会话 history。
 * - maxSeqInclusive：仅含 seq ≤ 该值（fork 分叉点及之前）
 * - maxSeqExclusive：仅含 seq < 该值（edit-resend 不含当前待重发 user）
 */
export async function loadConversationHistory(
  sessionId: string,
  opts?: { maxSeqInclusive?: number; maxSeqExclusive?: number },
): Promise<ChatMessage[]> {
  const db = await getDb();
  const conditions = [eq(messages.sessionId, sessionId)];
  // 含分叉点及之前的消息
  if (opts?.maxSeqInclusive !== undefined) {
    conditions.push(lte(messages.seq, opts.maxSeqInclusive));
  }
  // 不含当前待重发 user（send 单独推，避免双份）
  if (opts?.maxSeqExclusive !== undefined) {
    conditions.push(lt(messages.seq, opts.maxSeqExclusive));
  }
  const rows = await db
    .select({ role: messages.role, parts: messages.parts })
    .from(messages)
    .where(and(...conditions))
    .orderBy(asc(messages.seq));
  return buildHistoryFromRows(rows);
}

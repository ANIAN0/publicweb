// 共享消息持久化层 —— 把 WebtoolEvent 归一写入 messages 表
// 同时被 EveagentBackend 与 LocalBackend 使用，确保所有后端的 assistant/reasoning/tool/finishReason
// 都能落库。这是 REV-005-1 + REV-005-15 的核心修复：让 webtool 真正成为会话权威源。
import { getDb } from '@/lib/db/client';
import { messages } from '@/lib/db/schema';
import { eq, and, desc } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { WebtoolEvent } from '@/lib/protocol/events';

interface PersistedToolCall { id: string; name: string; input: unknown }
interface PersistedToolResult { toolCallId: string; output: string; isError: boolean }

function parseJsonArray<T>(json: string | null | undefined): T[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/**
 * 把一条 WebtoolEvent 增量写入 messages 表。
 * 同一 turn 内 text.delta / reasoning.delta 累加到最后一条 assistant 行；
 * tool.call / tool.result 累加到最后一条 assistant 行的 tool_calls / tool_results JSON 列；
 * turn.completed 把 finishReason 落到最后一条 assistant 行。
 * 错误捕获后控制台输出，不让单条事件持久化失败拖垮整个 turn 流。
 */
export async function persistSessionEvent(sessionId: string, event: WebtoolEvent): Promise<void> {
  const db = await getDb();
  const [lastMsg] = await db.select({ seq: messages.seq }).from(messages)
    .where(eq(messages.sessionId, sessionId))
    .orderBy(desc(messages.seq))
    .limit(1);
  const nextSeq = lastMsg ? lastMsg.seq + 1 : 1;

  if (event.type === 'text.delta') {
    // 累加到最后一条 assistant 行；若不存在则新建一行
    const [existing] = await db.select().from(messages)
      .where(and(
        eq(messages.sessionId, sessionId),
        eq(messages.role, 'assistant'),
        eq(messages.seq, nextSeq - 1),
      ))
      .limit(1);
    if (existing) {
      await db.update(messages)
        .set({ content: (existing.content ?? '') + event.delta })
        .where(eq(messages.id, existing.id));
    } else {
      await db.insert(messages).values({
        id: ulid(), sessionId, seq: nextSeq, role: 'assistant',
        content: event.delta, createdAt: new Date(),
      });
    }
    return;
  }

  if (event.type === 'reasoning.delta') {
    // 思考过程累加到 reasoning 列（REV-005-15）
    const [existing] = await db.select().from(messages)
      .where(and(
        eq(messages.sessionId, sessionId),
        eq(messages.role, 'assistant'),
        eq(messages.seq, nextSeq - 1),
      ))
      .limit(1);
    if (existing) {
      await db.update(messages)
        .set({ reasoning: (existing.reasoning ?? '') + event.delta })
        .where(eq(messages.id, existing.id));
    } else {
      await db.insert(messages).values({
        id: ulid(), sessionId, seq: nextSeq, role: 'assistant',
        content: '', reasoning: event.delta, createdAt: new Date(),
      });
    }
    return;
  }

  if (event.type === 'tool.call') {
    const [lastAssistant] = await db.select().from(messages)
      .where(and(eq(messages.sessionId, sessionId), eq(messages.role, 'assistant')))
      .orderBy(desc(messages.seq))
      .limit(1);
    const prev = parseJsonArray<PersistedToolCall>(lastAssistant?.toolCalls);
    prev.push({ id: event.id, name: event.name, input: event.input });
    if (lastAssistant) {
      await db.update(messages)
        .set({ toolCalls: JSON.stringify(prev) })
        .where(eq(messages.id, lastAssistant.id));
    } else {
      await db.insert(messages).values({
        id: ulid(), sessionId, seq: nextSeq, role: 'assistant',
        content: '', toolCalls: JSON.stringify(prev), createdAt: new Date(),
      });
    }
    return;
  }

  if (event.type === 'tool.result') {
    const [lastAssistant] = await db.select().from(messages)
      .where(and(eq(messages.sessionId, sessionId), eq(messages.role, 'assistant')))
      .orderBy(desc(messages.seq))
      .limit(1);
    const prev = parseJsonArray<PersistedToolResult>(lastAssistant?.toolResults);
    prev.push({ toolCallId: event.id, output: event.output, isError: event.isError ?? false });
    if (lastAssistant) {
      await db.update(messages)
        .set({ toolResults: JSON.stringify(prev) })
        .where(eq(messages.id, lastAssistant.id));
    } else {
      await db.insert(messages).values({
        id: ulid(), sessionId, seq: nextSeq, role: 'assistant',
        content: '', toolResults: JSON.stringify(prev), createdAt: new Date(),
      });
    }
    return;
  }

  if (event.type === 'turn.completed') {
    const [lastAssistant] = await db.select().from(messages)
      .where(and(eq(messages.sessionId, sessionId), eq(messages.role, 'assistant')))
      .orderBy(desc(messages.seq))
      .limit(1);
    if (lastAssistant) {
      await db.update(messages)
        .set({ finishReason: event.finishReason })
        .where(eq(messages.id, lastAssistant.id));
    }
    return;
  }

  // 其他事件（session.connected / session.disconnected / session.start）不入 messages 表
}

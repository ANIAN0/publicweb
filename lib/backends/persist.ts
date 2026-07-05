// 共享消息持久化层 —— 把 WebtoolEvent(part 增量)累积写入 messages 表的 parts JSON 列
// 同时被 EveagentBackend 与 LocalBackend 使用。对齐 AI SDK UIMessage(见 03-protocol-contract.md)。
// partId 靠 part 内 _pid 字段定位(见 06-backend-id-system.md),persist 无状态。
// 错误捕获后控制台输出,不让单条事件持久化失败拖垮整个 turn 流。
import { getDb } from '@/lib/db/client';
import { messages } from '@/lib/db/schema';
import { eq, and, desc } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { WebtoolEvent, WebtoolMessageMetadata, PersistedPart } from '@/lib/protocol/events';

// 解析 parts JSON;空/损坏返回 [](防 JSON 解析失败拖垮整个 turn)
function parseParts(json: string | null | undefined): PersistedPart[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// 解析 metadata JSON;空/损坏返回 {}
function parseMetadata(json: string | null | undefined): WebtoolMessageMetadata {
  if (!json) return {};
  try {
    const v = JSON.parse(json);
    return (v && typeof v === 'object') ? v as WebtoolMessageMetadata : {};
  } catch {
    return {};
  }
}

// 取当前 turn 的 assistant 消息:最后一条 role=assistant 且 metadata.finishReason 未定。
// 若不存在或已 finalized,则新建一条空 parts 的 assistant 消息。
// turn.completed 落 finishReason 后,下个 part.start 自动开新消息——这是 turn 边界。
async function getOrCreateCurrentAssistant(sessionId: string): Promise<{ id: string; parts: PersistedPart[]; metadata: WebtoolMessageMetadata }> {
  const db = await getDb();
  const [last] = await db.select().from(messages)
    .where(and(eq(messages.sessionId, sessionId), eq(messages.role, 'assistant')))
    .orderBy(desc(messages.seq))
    .limit(1);
  if (last) {
    const meta = parseMetadata(last.metadata);
    // finishReason 未定 = 当前 turn 还在进行,复用这条
    if (meta.finishReason === undefined) {
      return { id: last.id, parts: parseParts(last.parts), metadata: meta };
    }
  }
  // 新建 assistant 消息(seq = 当前 session 最大 seq + 1)
  const [lastSeq] = await db.select({ seq: messages.seq }).from(messages)
    .where(eq(messages.sessionId, sessionId))
    .orderBy(desc(messages.seq))
    .limit(1);
  const nextSeq = lastSeq ? lastSeq.seq + 1 : 1;
  const id = ulid();
  await db.insert(messages).values({
    id, sessionId, seq: nextSeq, role: 'assistant',
    parts: JSON.stringify([]), metadata: null, createdAt: new Date(),
  });
  return { id, parts: [], metadata: {} };
}

// 在 parts 里按 _pid 查找下标;找不到返回 -1
function findPartIndex(parts: PersistedPart[], partId: string): number {
  return parts.findIndex((p) => (p as { _pid?: string })._pid === partId);
}

/**
 * 把一条 WebtoolEvent 增量写入 messages 表。
 * part.start/delta/update/end 操作当前 assistant 消息的 parts JSON 列;
 * message.metadata 累积到 metadata 列;
 * turn.completed 把 finishReason 落到 metadata 列(标志 turn 结束,下个 part 开新消息)。
 */
export async function persistSessionEvent(sessionId: string, event: WebtoolEvent): Promise<void> {
  const db = await getDb();
  try {
    if (event.type === 'part.start') {
      const cur = await getOrCreateCurrentAssistant(sessionId);
      // 注入 _pid(供后续 part.delta/update 定位),挂到 parts 末尾保序
      const part: PersistedPart = { ...event.part, _pid: event.partId } as PersistedPart;
      cur.parts.push(part);
      await db.update(messages).set({ parts: JSON.stringify(cur.parts) }).where(eq(messages.id, cur.id));
      return;
    }

    if (event.type === 'part.delta') {
      const cur = await getOrCreateCurrentAssistant(sessionId);
      const idx = findPartIndex(cur.parts, event.partId);
      if (idx < 0) return; // part 不存在(不应发生),忽略防崩溃
      const part = cur.parts[idx] as Record<string, unknown>;
      if (event.field === 'text' || event.field === 'reasoning') {
        // AI SDK 的 TextUIPart 和 ReasoningUIPart 文本字段都叫 text
        part.text = ((part.text as string) ?? '') + event.delta;
      } else if (event.field === 'input') {
        // tool input 是 JSON 片段累加(input-streaming 期间 input 存为字符串,part.update 转 input-available 时替换为对象)
        const cur2 = part.input;
        part.input = (typeof cur2 === 'string' ? cur2 : '') + event.delta;
      }
      await db.update(messages).set({ parts: JSON.stringify(cur.parts) }).where(eq(messages.id, cur.id));
      return;
    }

    if (event.type === 'part.update') {
      const cur = await getOrCreateCurrentAssistant(sessionId);
      const idx = findPartIndex(cur.parts, event.partId);
      if (idx < 0) return;
      // patch 浅合并到 part(state 变化、output、errorText、approval、preliminary、input 替换)
      cur.parts[idx] = { ...cur.parts[idx], ...event.patch } as PersistedPart;
      await db.update(messages).set({ parts: JSON.stringify(cur.parts) }).where(eq(messages.id, cur.id));
      return;
    }

    if (event.type === 'part.end') {
      const cur = await getOrCreateCurrentAssistant(sessionId);
      const idx = findPartIndex(cur.parts, event.partId);
      if (idx < 0) return;
      // 带最终快照则替换(落库 + 前端校正),保留 _pid
      if (event.part) {
        cur.parts[idx] = { ...event.part, _pid: event.partId } as PersistedPart;
      }
      await db.update(messages).set({ parts: JSON.stringify(cur.parts) }).where(eq(messages.id, cur.id));
      return;
    }

    if (event.type === 'message.metadata') {
      const cur = await getOrCreateCurrentAssistant(sessionId);
      const merged: WebtoolMessageMetadata = { ...cur.metadata, ...event.metadata };
      await db.update(messages).set({ metadata: JSON.stringify(merged) }).where(eq(messages.id, cur.id));
      return;
    }

    if (event.type === 'turn.completed') {
      const cur = await getOrCreateCurrentAssistant(sessionId);
      // turn 结束收尾:把所有还在 streaming 的 part 置 done。
      // 防 eve 短 reasoning 不发 reasoning.completed、或中断时 part 卡 streaming(前端渲染一直转圈不结束)。
      let partsChanged = false;
      for (const p of cur.parts) {
        if ((p as { state?: string }).state === 'streaming') {
          (p as { state?: string }).state = 'done';
          partsChanged = true;
        }
      }
      // finishReason 落 metadata,标志 turn 结束;下个 part.start 会开新 assistant 消息
      const merged: WebtoolMessageMetadata = { ...cur.metadata, finishReason: event.finishReason };
      await db.update(messages).set({
        ...(partsChanged ? { parts: JSON.stringify(cur.parts) } : {}),
        metadata: JSON.stringify(merged),
      }).where(eq(messages.id, cur.id));
      return;
    }

    // session.connected / session.disconnected / session.start 不入 messages 表
  } catch (err) {
    console.error(`[persist] failed sessionId=${sessionId} event=${event.type}:`, err);
  }
}

// 从 parts JSON 提取文本(拼接所有 text part 的 text)——供 history 读取降级使用
// (eve clientContext / claude+pi history 重建,见 05-schema-design.md 降级点 #2,后续 adapter 改造传完整 parts)
export function extractTextFromParts(partsJson: string | null | undefined): string {
  return parseParts(partsJson)
    .filter((p) => p.type === 'text')
    .map((p) => (p as { text?: string }).text ?? '')
    .join('');
}

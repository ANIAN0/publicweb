// Fork：从某条消息处开新会话分支
// 复制 ≤ fromMessage.seq 的消息到新 session，不继承 backendSessionRef（全新 agent 上下文）
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/db/client';
import { sessions, messages } from '@/lib/db/schema';
import { eq, and, lte, asc } from 'drizzle-orm';
import { ulid } from 'ulid';
import { getActiveSession } from '@/lib/api/get-active-session';
import { getBackendAdapter } from '@/lib/backends/router';
import { buildHistoryFromRows } from '@/lib/chat/history';
import { parseJsonBody } from '@/lib/api/parse-json-body';
import { debugLog } from '@/lib/debug-log';

const forkBodySchema = z.object({
  fromMessageId: z.string().min(1),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: sourceId } = await params;
  // APP-004：Zod 校验 body
  const parsed = await parseJsonBody(request, forkBodySchema);
  if (!parsed.ok) return parsed.response;
  const { fromMessageId } = parsed.data;

  const source = await getActiveSession(sourceId);
  if (!source) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  const db = await getDb();
  const [fromMsg] = await db.select().from(messages)
    .where(and(eq(messages.sessionId, sourceId), eq(messages.id, fromMessageId)))
    .limit(1);
  if (!fromMsg) {
    return NextResponse.json({ error: 'Message not found' }, { status: 404 });
  }

  const toCopy = await db.select().from(messages)
    .where(and(eq(messages.sessionId, sourceId), lte(messages.seq, fromMsg.seq)))
    .orderBy(asc(messages.seq));

  const newId = ulid();
  const now = new Date();
  const branchTitleBase = source.userTitle || source.title || '对话';
  const branchTitle = `${branchTitleBase} · 分支`.slice(0, 60);

  try {
    await db.insert(sessions).values({
      id: newId,
      backend: source.backend,
      model: source.model,
      targetId: source.targetId,
      cwd: source.cwd,
      title: branchTitle,
      userTitle: null,
      eveSessionId: null,
      eveContinuationToken: null,
      localSessionRef: null,
      streamIndex: 0,
      createdAt: now,
      lastActiveAt: now,
    });

    // APP-010：一次 multi-values insert，禁止 for 循环逐条 insert
    if (toCopy.length > 0) {
      await db.insert(messages).values(
        toCopy.map((m, i) => ({
          id: ulid(),
          sessionId: newId,
          seq: i + 1,
          role: m.role,
          parts: m.parts,
          metadata: m.metadata,
          createdAt: m.createdAt ?? now,
        })),
      );
    }
    debugLog('app', `fork batch insert ok source=${sourceId} new=${newId} count=${toCopy.length}`);

    const history = buildHistoryFromRows(toCopy);
    const adapter = getBackendAdapter(source.backend);
    await adapter.startSession({
      sessionId: newId,
      model: source.model,
      targetId: source.targetId,
      history,
      cwd: source.cwd ?? undefined,
    });
  } catch (err) {
    debugLog('app', `fork failed source=${sourceId}: ${err instanceof Error ? err.message : String(err)}`);
    console.error(`[fork] failed source=${sourceId}:`, err);
    await db.delete(messages).where(eq(messages.sessionId, newId)).catch(() => {});
    await db.delete(sessions).where(eq(sessions.id, newId)).catch(() => {});
    const message = err instanceof Error ? err.message : 'fork failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }

  return NextResponse.json({
    id: newId,
    forkedFrom: sourceId,
    fromMessageId,
    title: branchTitle,
  }, { status: 201 });
}

// 编辑 / 重发 / 再生成：
// 1) 定位目标 user 消息 2) 截断其后所有消息 3) 可选改写 content
// 4) 清 backend 续接引用并 restart 5) 重新 adapter.send
// 禁止只改 UI 不截断（否则 agent 上下文与气泡不一致）
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getDb, withImmediateTransaction } from '@/lib/db/client';
import { sessions, messages } from '@/lib/db/schema';
import { eq, and, gt, desc } from 'drizzle-orm';
import { getActiveSession } from '@/lib/api/get-active-session';
import { getBackendAdapter } from '@/lib/backends/router';
import { loadConversationHistory } from '@/lib/chat/history';
import { extractTextFromParts } from '@/lib/chat/parts';
import { parseJsonBody } from '@/lib/api/parse-json-body';
import { ulid } from 'ulid';
import { TurnBusyError, releaseTurnLock, settleTurnLock, withTurnLock } from '@/lib/backends/turn-lock';
import { beginTurnMaterialize } from '@/lib/backends/persist';
import { validateTargetModel } from '@/lib/backends/validate-model';

type Mode = 'edit' | 'resend' | 'regenerate';

// APP-004：edit-resend body Zod
const editResendSchema = z.object({
  messageId: z.string().min(1),
  content: z.string().optional(),
  mode: z.enum(['edit', 'resend', 'regenerate']).optional(),
  model: z.string().min(1).optional(),
}).superRefine((b, ctx) => {
  const mode = b.mode ?? 'resend';
  if (mode === 'edit' && (!b.content || !b.content.trim())) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'edit requires non-empty content' });
  }
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: sessionId } = await params;
  const parsed = await parseJsonBody(request, editResendSchema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  const mode: Mode = body.mode ?? 'resend';

  // APP-001：未删除 session
  const session = await getActiveSession(sessionId);
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  const db = await getDb();
  const [target] = await db.select().from(messages)
    .where(and(eq(messages.sessionId, sessionId), eq(messages.id, body.messageId)))
    .limit(1);
  if (!target) {
    return NextResponse.json({ error: 'Message not found' }, { status: 404 });
  }

  // regenerate：点在 assistant 上 → 回退到前一条 user；点在 user 上 = resend
  let userMsg = target;
  if (mode === 'regenerate' && target.role !== 'user') {
    const earlierUsers = await db.select().from(messages)
      .where(and(eq(messages.sessionId, sessionId), eq(messages.role, 'user')))
      .orderBy(desc(messages.seq));
    const found = earlierUsers.find((m) => m.seq < target.seq);
    if (!found) {
      return NextResponse.json({ error: 'no preceding user message' }, { status: 400 });
    }
    userMsg = found;
  } else if (mode !== 'regenerate' && target.role !== 'user') {
    return NextResponse.json({ error: 'edit/resend only applies to user messages' }, { status: 400 });
  }

  // 先计算待发送内容；拿锁和 backend restart 成功前不破坏历史。
  let sendContent = extractTextFromParts(userMsg.parts);
  if (mode === 'edit' && body.content) {
    sendContent = body.content.trim();
  }

  if (!sendContent.trim()) {
    return NextResponse.json({ error: 'empty user content' }, { status: 400 });
  }

  const adapter = getBackendAdapter(session.backend);
  const sendModel = body.model ?? session.model;
  if (body.model) {
    const modelError = await validateTargetModel(adapter, session.targetId, body.model);
    if (modelError) {
      return NextResponse.json({ error: modelError }, { status: 400 });
    }
  }

  // APP-008/009：history 不含当前待重发 user（send 单独推），避免双份
  const history = await loadConversationHistory(sessionId, {
    maxSeqExclusive: userMsg.seq,
  });

  const now = new Date();
  const runId = ulid();
  try {
    await withTurnLock({
      backend: session.backend,
      targetId: session.targetId,
      sessionId,
      runId,
      acquiredAt: now,
    }, async () => undefined);
  } catch (err) {
    if (err instanceof TurnBusyError) {
      return NextResponse.json({
        error: err.conflictingSessionId === sessionId ? 'turn_in_progress' : 'target_busy',
        conflictingSessionId: err.conflictingSessionId,
      }, { status: 409 });
    }
    throw err;
  }

  try {
    // startSession 必须看到已清空的续接引用，否则 local/eve 会继续旧上下文。
    await db.update(sessions).set({
      eveSessionId: null,
      eveContinuationToken: null,
      localSessionRef: null,
      streamIndex: 0,
    }).where(eq(sessions.id, sessionId));
    await adapter.stop(sessionId).catch(() => {});
    await adapter.startSession({
      sessionId,
      model: sendModel,
      targetId: session.targetId,
      history,
      cwd: session.cwd ?? undefined,
    });
  } catch (err) {
    await db.update(sessions).set({
      eveSessionId: session.eveSessionId,
      eveContinuationToken: session.eveContinuationToken,
      localSessionRef: session.localSessionRef,
      streamIndex: session.streamIndex,
    }).where(eq(sessions.id, sessionId)).catch(() => {});
    await releaseTurnLock(sessionId, runId);
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `restart failed: ${msg}` }, { status: 503 });
  }

  try {
    await withImmediateTransaction(async (tx) => {
      await tx.delete(messages).where(and(
        eq(messages.sessionId, sessionId),
        gt(messages.seq, userMsg.seq),
      ));
      if (mode === 'edit') {
        await tx.update(messages)
          .set({ parts: JSON.stringify([{ type: 'text', text: sendContent }]) })
          .where(eq(messages.id, userMsg.id));
      }
      await tx.update(sessions).set({
        pendingUserMessage: sendContent,
        pendingUserMessageCreatedAt: now,
        lastActiveAt: now,
      }).where(eq(sessions.id, sessionId));
    });
    beginTurnMaterialize(sessionId, runId);
    await adapter.send(sessionId, sendContent, { runId, model: sendModel });
  } catch (err) {
    await settleTurnLock(sessionId, runId);
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `send failed: ${msg}` }, { status: 503 });
  }

  return NextResponse.json({
    ok: true,
    runId,
    mode,
    userMessageId: userMsg.id,
    content: sendContent,
  });
}

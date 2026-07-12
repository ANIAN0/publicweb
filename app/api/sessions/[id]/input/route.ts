// HITL 回答端点：走 BackendAdapter.respondInput 独立通道（不经 send）
// APP-018/027：Zod 校验 inputResponses，与读取一致
// DIAG-007：与 messages POST 一样 withTurnLock + beginTurnMaterialize，避免 HITL 续接与并发 send 竞态
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { ulid } from 'ulid';
import { getActiveSession } from '@/lib/api/get-active-session';
import { getBackendAdapter } from '@/lib/backends/router';
import { parseJsonBody } from '@/lib/api/parse-json-body';
import { debugLog } from '@/lib/debug-log';
import { beginTurnMaterialize } from '@/lib/backends/persist';
import { releaseTurnLock, TurnBusyError, withTurnLock } from '@/lib/backends/turn-lock';

const inputResponseSchema = z.object({
  requestId: z.string().min(1),
  decision: z.enum(['allow', 'deny', 'cancel']).optional(),
  optionId: z.string().optional(),
  text: z.string().optional(),
  answers: z
    .array(
      z.object({
        questionId: z.string().optional(),
        optionId: z.string().optional(),
        text: z.string().optional(),
      }),
    )
    .optional(),
}).superRefine((r, ctx) => {
  const isCancelOrDeny = r.decision === 'cancel' || r.decision === 'deny';
  const hasAnswer =
    r.optionId !== undefined ||
    r.text !== undefined ||
    (Array.isArray(r.answers) && r.answers.length > 0);
  if (!isCancelOrDeny && !hasAnswer) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'need decision cancel|deny or optionId|text|answers',
    });
  }
});

const bodySchema = z.object({
  inputResponses: z.array(inputResponseSchema).min(1),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const parsed = await parseJsonBody(request, bodySchema);
  if (!parsed.ok) return parsed.response;

  const session = await getActiveSession(id);
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  const { inputResponses } = parsed.data;
  const runId = ulid();
  const now = new Date();
  try {
    await withTurnLock({
      backend: session.backend,
      targetId: session.targetId,
      sessionId: id,
      runId,
      acquiredAt: now,
    }, async () => {
      // 仅占锁；实际 run 在 adapter 异步链上执行
    });
  } catch (err) {
    if (err instanceof TurnBusyError) {
      return NextResponse.json({
        error: err.conflictingSessionId === id ? 'turn_in_progress' : 'target_busy',
        message: err.conflictingSessionId === id
          ? '当前会话已有进行中的回复，请等待完成或停止后再回答'
          : '该执行端已有其他会话的进行中 turn，请稍后再试',
        conflictingSessionId: err.conflictingSessionId,
      }, { status: 409 });
    }
    const msg = err instanceof Error ? err.message : String(err);
    debugLog('app', `respondInput lock failed sid=${id} err=${msg}`);
    return NextResponse.json({ error: 'lock_failed', detail: msg }, { status: 500 });
  }

  beginTurnMaterialize(id, runId);
  const adapter = getBackendAdapter(session.backend);
  adapter.respondInput(id, inputResponses, { runId }).catch(async (err) => {
    debugLog('app', `respondInput failed sid=${id}: ${err instanceof Error ? err.message : String(err)}`);
    console.error(`[input] respondInput failed sid=${id}:`, err);
    await releaseTurnLock(id, runId).catch(() => {});
  });

  return NextResponse.json({ ok: true, runId }, { status: 200 });
}

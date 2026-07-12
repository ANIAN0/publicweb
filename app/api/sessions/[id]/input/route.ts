// HITL 回答端点：走 BackendAdapter.respondInput 独立通道（不经 send）
// APP-018/027：Zod 校验 inputResponses，与读取一致
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getActiveSession } from '@/lib/api/get-active-session';
import { getBackendAdapter } from '@/lib/backends/router';
import { parseJsonBody } from '@/lib/api/parse-json-body';
import { debugLog } from '@/lib/debug-log';

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
  const adapter = getBackendAdapter(session.backend);
  adapter.respondInput(id, inputResponses).catch((err) => {
    debugLog('app', `respondInput failed sid=${id}: ${err instanceof Error ? err.message : String(err)}`);
    console.error(`[input] respondInput failed sid=${id}:`, err);
  });

  return NextResponse.json({ ok: true }, { status: 200 });
}

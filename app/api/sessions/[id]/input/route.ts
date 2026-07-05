// HITL 回答端点:把用户对 ask_question / tool-approval 的回答透传给后端 adapter
// eve 路线:adapter.send(id, '', { inputResponses }) → clientSession.send({ inputResponses }) → durable session 续接
// 不插 user 消息(HITL 回答不是新用户消息,是同一 turn 内的回应),与 messages POST 区分语义
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';
import { sessions } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { getBackendAdapter } from '@/lib/backends/router';
import type { InputResponse } from '@/lib/protocol/events';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json();
  const { inputResponses } = body as { inputResponses?: InputResponse[] };

  // 校验:inputResponses 必须是非空数组,每项至少有 requestId + (optionId | text)
  if (!Array.isArray(inputResponses) || inputResponses.length === 0) {
    return NextResponse.json({ error: 'inputResponses is required' }, { status: 400 });
  }
  for (const r of inputResponses) {
    if (!r?.requestId || (r.optionId === undefined && r.text === undefined)) {
      return NextResponse.json({ error: 'each response needs requestId + (optionId | text)' }, { status: 400 });
    }
  }

  const db = await getDb();
  const [session] = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  // fire-and-forget:对齐 messages route 风格;eve resume 后续流通过 SSE 推回前端
  // 错误(如 eve session 过期)落在 adapter 内部日志,前端靠乐观更新 + reload 恢复
  const adapter = getBackendAdapter(session.backend);
  adapter.send(id, '', { inputResponses }).catch((err) => {
    console.error(`[input] deliver failed sid=${id}:`, err);
  });

  return NextResponse.json({ ok: true }, { status: 200 });
}

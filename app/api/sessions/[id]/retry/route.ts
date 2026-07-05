// POST /api/sessions/[id]/retry
// 手动重试：当 session 因 device 离线 / 异常中断后，用户点"重试"按钮触发
// 走与 POST /api/sessions (新建) 相同的 router.startSession 流程：
//   - eveagent：调 remote startSession（无副作用：eveagent startSession 只校验 row 存在）
//   - claudecode / pi：通过反向 WS 派发 session.start 给 device（device 上线后才会真生效）
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';
import { sessions, messages } from '@/lib/db/schema';
import { eq, and, isNull, asc } from 'drizzle-orm';
import { getBackendAdapter } from '@/lib/backends/router';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const db = await getDb();
  const [session] = await db.select().from(sessions)
    .where(and(eq(sessions.id, id), isNull(sessions.deletedAt)))
    .limit(1);
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  // 从 DB 读 history（含 user + assistant）作为 client context
  const historyRows = await db.select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(eq(messages.sessionId, id))
    .orderBy(asc(messages.seq));
  const history = historyRows
    .filter((r) => r.role === 'user' || r.role === 'assistant')
    .map((r) => ({ role: r.role as 'user' | 'assistant', content: r.content }));

  // 调对应 adapter.startSession:targetId 多态(local=device.id 派发 WS,eveagent=eve_service.id 选 host)
  const adapter = getBackendAdapter(session.backend);
  try {
    await adapter.startSession({
      sessionId: id,
      model: session.model,
      targetId: session.targetId,
      history,
    });
  } catch (err: any) {
    // device 离线等情况下 LocalBackend.startSession 会抛错；返回 503 让前端能识别
    console.error('retry startSession error:', err);
    return NextResponse.json({ error: err?.message ?? 'retry failed' }, { status: 503 });
  }

  return NextResponse.json({ id, retried: true });
}
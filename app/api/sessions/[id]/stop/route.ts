// POST /api/sessions/[id]/stop
// 主动停止当前 turn；通过 backend adapter 派发 stop 信号
//   - eveagent：触发 in-flight send 的 AbortSignal（HTTP POST 与 stream 都会被取消）
//   - claudecode / pi：通过反向 WS 发 session.stop 给本地 client
// 设计：stop 不 kill agent 进程（按 F-009 需求）；仅取消当前 turn
//   - 流停止时由 adapter 写最后一条 assistant 消息的 finishReason='interrupted'
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';
import { sessions } from '@/lib/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { getBackendAdapter } from '@/lib/backends/router';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // 必须存在且未删除才允许 stop（404 让前端能给出明确反馈）
  const db = await getDb();
  const [session] = await db.select().from(sessions)
    .where(and(eq(sessions.id, id), isNull(sessions.deletedAt)))
    .limit(1);
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  // adapter.stop 是幂等的：没在跑也安全
  const adapter = getBackendAdapter(session.backend);
  await adapter.stop(id);

  return NextResponse.json({ id, stopped: true });
}
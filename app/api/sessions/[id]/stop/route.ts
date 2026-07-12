// POST /api/sessions/[id]/stop
// 主动停止当前 turn；通过 backend adapter 派发 stop 信号
//   - eveagent：触发 in-flight send 的 AbortSignal（HTTP POST 与 stream 都会被取消）
//   - claudecode / pi：通过反向 WS 发 session.stop 给本地 client
// 设计：stop 不 kill agent 进程（按 F-009 需求）；仅取消当前 turn
//   - 流停止时由 adapter 写最后一条 assistant 消息的 finishReason='interrupted'
import { NextRequest, NextResponse } from 'next/server';
import { getActiveSession } from '@/lib/api/get-active-session';
import { getBackendAdapter } from '@/lib/backends/router';
import { settleTurnInterrupted } from '@/lib/backends/persist';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // APP-001：必须存在且未删除才允许 stop
  const session = await getActiveSession(id);
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  // adapter.stop 是幂等的：没在跑也安全
  const adapter = getBackendAdapter(session.backend);
  await adapter.stop(id);
  // adapter 事件可能迟到或丢失；服务端立即执行幂等终态并释放当前 run 锁。
  await settleTurnInterrupted(id, 'interrupted', {
    code: 'user_stop',
    message: 'user stopped the turn',
  });

  return NextResponse.json({ id, stopped: true });
}

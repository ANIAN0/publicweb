// POST /api/sessions/[id]/retry
// 手动重试：当 session 因 device 离线 / 异常中断后，用户点"重试"按钮触发
// 走与 POST /api/sessions (新建) 相同的 router.startSession 流程：
//   - eveagent：调 remote startSession（无副作用：eveagent startSession 只校验 row 存在）
//   - claudecode / pi：通过反向 WS 派发 session.start 给 device（device 上线后才会真生效）
import { NextRequest, NextResponse } from 'next/server';
import { getActiveSession } from '@/lib/api/get-active-session';
import { getBackendAdapter } from '@/lib/backends/router';
import { loadConversationHistory } from '@/lib/chat/history';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // APP-001：未删除 session
  const session = await getActiveSession(id);
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  // APP-008/009：共用 history helper
  const history = await loadConversationHistory(id);

  // 调对应 adapter.startSession:targetId 多态(local=device.id 派发 WS,eveagent=eve_service.id 选 host)
  // cwd 必须透传，否则 local 子进程静默掉回 client 默认目录
  const adapter = getBackendAdapter(session.backend);
  try {
    await adapter.startSession({
      sessionId: id,
      model: session.model,
      targetId: session.targetId,
      history,
      cwd: session.cwd ?? undefined,
    });
  } catch (err: any) {
    // device 离线等情况下 LocalBackend.startSession 会抛错；返回 503 让前端能识别
    console.error('retry startSession error:', err);
    return NextResponse.json({ error: err?.message ?? 'retry failed' }, { status: 503 });
  }

  return NextResponse.json({ id, retried: true });
}

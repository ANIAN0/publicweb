// 会话软删：写 deletedAt + 释放 turn 锁 + 释放 adapter 运行时
// 单条 DELETE 与 bulk-delete 共用，语义一致
import { getDb } from '@/lib/db/client';
import { sessions } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { debugLog } from '@/lib/debug-log';
import { getActiveSession } from '@/lib/api/get-active-session';
import { releaseTurnLock } from '@/lib/backends/turn-lock';
import { sendToDevice } from '@/server/ws/device-connections';

export type SoftDeleteResult = 'deleted' | 'skipped';

/**
 * 软删未删除会话。不存在或已删 → skipped（调用方映射 404 / bulk skipped）。
 *
 * 注意：禁止在此路径调用 adapter.stop()。
 * local.stop 会 re-bind + emit abort → persist 按 DEF-002 新建 interrupted assistant；
 * 批量删除时每条都落库，请求极慢，Next 首次编译时终端会长时间停在
 * 「○ Compiling /api/sessions/bulk-delete ...」。
 * 销毁会话只应 releaseRuntime；local 设备用 session.stop 尽力通知 client，不写服务端终态消息。
 */
export async function softDeleteSession(id: string): Promise<SoftDeleteResult> {
  const session = await getActiveSession(id);
  if (!session) return 'skipped';

  const db = await getDb();
  await db.update(sessions).set({ deletedAt: new Date() }).where(eq(sessions.id, id));
  await releaseTurnLock(id);

  try {
    debugLog('app', `softDelete releaseRuntime sid=${id} backend=${session.backend}`);
    const { getBackendAdapter } = await import('@/lib/backends/router');
    const adapter = getBackendAdapter(session.backend) as {
      releaseRuntime?: (sid: string) => void;
    };

    // eveagent.releaseRuntime 内部已 abort 进行中的 turn
    adapter.releaseRuntime?.(id);

    // local：映射已清，按 targetId 尽力下发 stop（无 throw、不写 abort 终态）
    if (
      (session.backend === 'claudecode' || session.backend === 'pi') &&
      session.targetId
    ) {
      sendToDevice(session.targetId, { type: 'session.stop', sessionId: id });
    }
  } catch (err) {
    debugLog(
      'app',
      `softDelete release failed sid=${id} err=${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return 'deleted';
}

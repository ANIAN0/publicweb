// 会话软删：写 deletedAt + 释放 turn 锁 + 释放 adapter 运行时
// 单条 DELETE 与 bulk-delete 共用，语义一致
import { getDb } from '@/lib/db/client';
import { sessions } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { debugLog } from '@/lib/debug-log';
import { getActiveSession } from '@/lib/api/get-active-session';
import { releaseTurnLock } from '@/lib/backends/turn-lock';

export type SoftDeleteResult = 'deleted' | 'skipped';

/**
 * 软删未删除会话。不存在或已删 → skipped（调用方映射 404 / bulk skipped）。
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
      stop?: (sid: string) => Promise<void>;
    };
    adapter.releaseRuntime?.(id);
    await adapter.stop?.(id);
  } catch (err) {
    debugLog(
      'app',
      `softDelete release failed sid=${id} err=${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return 'deleted';
}

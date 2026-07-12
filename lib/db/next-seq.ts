// 消息 seq 分配：max(seq)+1 + UNIQUE 冲突重试（LIB-004 / APP-005）
import { getDb } from './client';
import { messages } from './schema';
import { eq, desc } from 'drizzle-orm';
import { debugLog } from '../debug-log';
import {
  isUniqueConstraintError,
  withSeqRetryCore,
} from './next-seq-core';

export { isUniqueConstraintError, withSeqRetryCore } from './next-seq-core';

/** 生产路径：UNIQUE 冲突日志（可单测驱动，避免硬编码串） */
export function logSeqUniqueConflict(sessionId: string, seq: number, attempt: number): void {
  debugLog('persist', `seq UNIQUE conflict sid=${sessionId} seq=${seq} attempt=${attempt} — retry`);
}

/** 生产路径：insert 最终失败日志 */
export function logSeqInsertFail(
  sessionId: string,
  attempt: number,
  isUnique: boolean,
  err: unknown,
): void {
  debugLog(
    'persist',
    `seq insert failed sid=${sessionId} attempt=${attempt} unique=${isUnique} err=${err instanceof Error ? err.message : String(err)}`,
  );
}

/** 读取 session 当前最大 seq；无消息返回 0 */
export async function getMaxSeq(sessionId: string): Promise<number> {
  const db = await getDb();
  const [last] = await db
    .select({ seq: messages.seq })
    .from(messages)
    .where(eq(messages.sessionId, sessionId))
    .orderBy(desc(messages.seq))
    .limit(1);
  return last?.seq ?? 0;
}

/** 分配下一个 seq：读 max+1 */
export async function allocateNextSeq(sessionId: string): Promise<number> {
  const max = await getMaxSeq(sessionId);
  return max + 1;
}

export type InsertWithSeqFn<T> = (seq: number) => Promise<T>;

/**
 * 带 UNIQUE 冲突重试的 insert 包装。
 */
export async function withSeqRetry<T>(
  sessionId: string,
  insertFn: InsertWithSeqFn<T>,
  maxAttempts = 5,
): Promise<T> {
  return withSeqRetryCore(
    () => allocateNextSeq(sessionId),
    insertFn,
    {
      maxAttempts,
      onConflict: (seq, attempt) => logSeqUniqueConflict(sessionId, seq, attempt),
      onFail: (err, attempt, isUnique) => logSeqInsertFail(sessionId, attempt, isUnique, err),
    },
  );
}

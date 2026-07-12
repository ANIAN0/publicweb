import { and, eq } from 'drizzle-orm';
import { getDb, withImmediateTransaction, type DbTransaction } from '@/lib/db/client';
import { sessions, turnLocks } from '@/lib/db/schema';
import { isUniqueConstraintError } from '@/lib/db/next-seq-core';

export function turnTargetKey(backend: string, targetId: string): string {
  return `${backend}:${targetId}`;
}

export class TurnBusyError extends Error {
  constructor(
    readonly targetKey: string,
    readonly conflictingSessionId?: string,
  ) {
    super('target already has an active turn');
    this.name = 'TurnBusyError';
  }
}

export async function withTurnLock<T>(opts: {
  backend: string;
  targetId: string;
  sessionId: string;
  runId: string;
  acquiredAt: Date;
}, work: (tx: DbTransaction) => Promise<T>): Promise<T> {
  const db = await getDb();
  const targetKey = turnTargetKey(opts.backend, opts.targetId);
  try {
    return await withImmediateTransaction(async (tx) => {
      await tx.insert(turnLocks).values({
        targetKey,
        sessionId: opts.sessionId,
        runId: opts.runId,
        acquiredAt: opts.acquiredAt,
      });
      return work(tx);
    });
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;
    const [owner] = await db.select({ sessionId: turnLocks.sessionId })
      .from(turnLocks)
      .where(eq(turnLocks.targetKey, targetKey))
      .limit(1);
    if (!owner) throw err;
    throw new TurnBusyError(targetKey, owner?.sessionId);
  }
}

export async function releaseTurnLock(sessionId: string, runId?: string): Promise<void> {
  const db = await getDb();
  await db.delete(turnLocks).where(
    runId
      ? and(eq(turnLocks.sessionId, sessionId), eq(turnLocks.runId, runId))
      : eq(turnLocks.sessionId, sessionId),
  );
}

/** 仅当锁仍属于该 run 时，原子清 pending 并释放锁。 */
export async function settleTurnLock(sessionId: string, runId?: string): Promise<boolean> {
  const db = await getDb();
  return withImmediateTransaction(async (tx) => {
    const conditions = [eq(turnLocks.sessionId, sessionId)];
    if (runId) conditions.push(eq(turnLocks.runId, runId));
    const [lock] = await tx.select({ runId: turnLocks.runId })
      .from(turnLocks)
      .where(and(...conditions))
      .limit(1);
    if (!lock) return false;
    await tx.update(sessions).set({
      pendingUserMessage: null,
      pendingUserMessageCreatedAt: null,
    }).where(eq(sessions.id, sessionId));
    await tx.delete(turnLocks).where(and(
      eq(turnLocks.sessionId, sessionId),
      eq(turnLocks.runId, lock.runId),
    ));
    return true;
  });
}

export async function getTurnRunId(sessionId: string): Promise<string | undefined> {
  const db = await getDb();
  const [lock] = await db.select({ runId: turnLocks.runId })
    .from(turnLocks)
    .where(eq(turnLocks.sessionId, sessionId))
    .limit(1);
  return lock?.runId;
}

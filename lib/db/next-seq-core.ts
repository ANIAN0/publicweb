// seq 重试纯逻辑（无 DB 依赖），供生产 withSeqRetry 与 pytest/node 单测共用（LIB-004/APP-005）

/**
 * 收集 error 及 cause 链上的文案（drizzle/sqlite-proxy/turso 常把真实原因塞进 cause）。
 * 顶层多为 "Failed query: insert..."，UNIQUE 只在 cause 里——不 unwrap 则 withSeqRetry 永不重试。
 */
function collectErrorText(err: unknown, depth = 0): string {
  if (err == null || depth > 6) return '';
  if (typeof err === 'string') return err;
  if (!(err instanceof Error)) return String(err);
  const parts = [err.message];
  // Node / drizzle 嵌套 cause
  if ('cause' in err && err.cause !== undefined) {
    parts.push(collectErrorText(err.cause, depth + 1));
  }
  return parts.filter(Boolean).join('\n');
}

/**
 * 判断是否为 UNIQUE 冲突（turso/sqlite/pg 文案兼容）。
 * 禁止把 FOREIGN KEY / NOT NULL / CHECK 等其它 constraint 当成 UNIQUE 重试。
 */
export function isUniqueConstraintError(err: unknown): boolean {
  // 必须扫 cause 链：生产环境 turso 错误形态为 Failed query + cause.UNIQUE
  const lower = collectErrorText(err).toLowerCase();
  if (!lower) return false;
  // 显式排除非 UNIQUE 约束，避免 includes('constraint') 误伤
  if (lower.includes('foreign key')) return false;
  if (lower.includes('not null')) return false;
  if (lower.includes('check constraint')) return false;
  return (
    /unique\s+constraint/.test(lower) ||
    /constraint\s+failed:\s*unique/.test(lower) ||
    lower.includes('constraint_unique') ||
    lower.includes('sqlite_constraint_unique') ||
    // Postgres
    lower.includes('duplicate key') ||
    // 部分驱动: UNIQUE constraint failed: table.col
    (lower.includes('unique') && lower.includes('constraint failed'))
  );
}

/**
 * 注入 allocate/insert 的重试核心。
 * UNIQUE 冲突有限次重试；非 UNIQUE 或耗尽立即抛出。
 */
export async function withSeqRetryCore<T>(
  allocate: () => Promise<number>,
  insertFn: (seq: number) => Promise<T>,
  opts?: {
    maxAttempts?: number;
    onConflict?: (seq: number, attempt: number) => void;
    onFail?: (err: unknown, attempt: number, isUnique: boolean) => void;
  },
): Promise<T> {
  const maxAttempts = opts?.maxAttempts ?? 5;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const seq = await allocate();
    try {
      return await insertFn(seq);
    } catch (err) {
      lastErr = err;
      const isUnique = isUniqueConstraintError(err);
      if (!isUnique || attempt === maxAttempts) {
        opts?.onFail?.(err, attempt, isUnique);
        throw err;
      }
      opts?.onConflict?.(seq, attempt);
    }
  }
  throw lastErr;
}

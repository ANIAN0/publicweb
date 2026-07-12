// 数据库驱动：turso（@tursodatabase/database）。
// turso 的 connect() 是 async-only，而 drizzle-orm 提供的各种 SQLite adapter
// （better-sqlite3、libsql、bun-sqlite 等）要么是同步，要么要求特定的运行时，
// 都会把 webtool 绑死在某个 SQLite 实现上。这里选 drizzle-orm/sqlite-proxy：
// 它不内置任何驱动，只要求我们提供一个 (sql, params, method) => Promise<{rows}>
// 的回调，从而完全解耦 drizzle 和具体的 SQLite 库。
//   - 'run' 方法：直接 stmt.run()，无需返回行
//   - 'get'/'all'/'values'：用 stmt.raw() 拿到数组形式（proxy 用 row[columnIndex] 取值，
//     必须是 positional rows，不能是对象行）
//   - migrate 走自定义 callback：conn.exec(sql) 顺序跑每条迁移语句
import path from 'path';
import { connect, type Database } from '@tursodatabase/database';
import { drizzle, type SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';
import * as schema from './schema';

declare global {
  // 全局缓存避免 Next.js dev 模式下 HMR 反复建连
  var __dbConn: Database | undefined;
  var __db: SqliteRemoteDatabase<typeof schema> | undefined;
  // sqlite-proxy 共用单连接；BEGIN 不能并发进入，事务必须在进程内串行。
  var __dbTransactionTail: Promise<void> | undefined;
}

// 把 libSQL 时代的 URI 还原为 turso 期望的原生路径：
//   'file:./data/webtool.db'           → './data/webtool.db'
//   'file::memory:?cache=shared'       → ':memory:'  （turso 不认 ?cache=shared 查询串）
//   其他                                → 原样返回
function resolveDbPath(): string {
  const url = process.env.DATABASE_URL || './data/webtool.db';
  const stripped = url.startsWith('file:') ? url.slice(5) : url;
  return stripped.split('?')[0];
}

function makeProxyCallback(conn: Database) {
  // drizzle-orm/sqlite-proxy 期望的回调签名：(sql, params, method) => Promise<{rows: any[]}>
  // 关键：proxy 用 row[columnIndex] 取值，所以 rows 必须是"数组的数组"（positional），
  // 不能是 [{col: val}]。tursodb 的 stmt.all() 默认返回对象，stmt.raw().all() 返回数组。
  return async (sqlStr: string, params: any[], method: 'run' | 'all' | 'values' | 'get') => {
    if (method === 'run') {
      const stmt = await conn.prepare(sqlStr);
      await stmt.run(...(params as any[]));
      return { rows: [] };
    }
    if (method === 'get') {
      const stmt = await conn.prepare(sqlStr);
      // raw(true) 开启 raw 模式（返回数组的数组，匹配 drizzle proxy 的 row[columnIndex] 索引）
      const row = await stmt.raw(true).get(...(params as any[]));
      return { rows: row === undefined || row === null ? [] : [row] };
    }
    // 'all' 与 'values' 走相同的实现：返回所有行（positional）
    const stmt = await conn.prepare(sqlStr);
    const rows = await stmt.raw(true).all(...(params as any[]));
    return { rows: rows as any[] };
  };
}

export async function getDb() {
  if (!global.__db) {
    // 复用 migrate() 已经建立的连接（in-memory 模式下至关重要，每条 connect(':memory:') 都是新库）
    if (!global.__dbConn) {
      global.__dbConn = await connect(resolveDbPath());
    }
    global.__db = drizzle(makeProxyCallback(global.__dbConn), { schema });
  }
  return global.__db;
}

type Db = Awaited<ReturnType<typeof getDb>>;
export type DbTransaction = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * 在共用连接上串行执行 BEGIN IMMEDIATE，避免并发请求互相触发
 * "cannot start a transaction within a transaction"。
 */
export async function withImmediateTransaction<T>(
  work: (tx: DbTransaction) => Promise<T>,
): Promise<T> {
  const previous = global.__dbTransactionTail ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  global.__dbTransactionTail = previous.then(() => gate);
  await previous;
  try {
    const db = await getDb();
    return await db.transaction(work, { behavior: 'immediate' });
  } finally {
    release();
  }
}

/** LIB-009：migrations 目录可配置，默认 path.resolve(cwd, 'drizzle') */
function resolveMigrationsFolder(): string {
  // WEBTOOL_DRIZZLE_DIR 可覆盖；始终 resolve 成绝对路径
  if (process.env.WEBTOOL_DRIZZLE_DIR) {
    return path.resolve(process.env.WEBTOOL_DRIZZLE_DIR);
  }
  return path.resolve(process.cwd(), 'drizzle');
}

export async function migrate() {
  // 复用 getDb() 的全局连接 —— 这样 :memory: 测试库也能看到表（每个 :memory: 连接独立）
  const conn = global.__dbConn ?? await (async () => {
    global.__dbConn = await connect(resolveDbPath());
    return global.__dbConn;
  })();
  const db = drizzle(makeProxyCallback(conn), { schema });
  const { migrate: drizzleMigrate } = await import('drizzle-orm/sqlite-proxy/migrator');
  await drizzleMigrate(
    db,
    async (queries) => {
      for (const q of queries) {
        await conn.exec(q);
      }
    },
    { migrationsFolder: resolveMigrationsFolder() },
  );
}

/** LIB-010：关闭连接须 await，避免竞态 */
export async function resetDb() {
  if (global.__dbConn) {
    try {
      const maybe = global.__dbConn.close() as void | Promise<void>;
      if (maybe && typeof (maybe as Promise<void>).then === 'function') {
        await maybe;
      }
    } catch {
      /* 关闭失败仍清全局引用 */
    }
  }
  global.__dbConn = undefined;
  global.__db = undefined;
  global.__dbTransactionTail = undefined;
}

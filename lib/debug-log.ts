// 异步缓冲调试日志 —— 关键节点统一落盘 workplace/logs/
// 修复 LIB-005：禁止热路径 appendFileSync 阻塞
// 约定前缀：[eve]/[ws]/[cli]/[persist]/[app] 等，便于关键字检索
import { appendFile, mkdir } from 'fs/promises';
import { join } from 'path';

export type LogPrefix = 'eve' | 'ws' | 'cli' | 'persist' | 'app' | 'local' | 'db';

// 队列项：前缀 + 消息 + 时间戳
interface LogItem {
  prefix: LogPrefix;
  msg: string;
  ts: string;
}

// 缓冲队列；flush 串行写盘，失败静默（日志不得拖垮主流程）
const queue: LogItem[] = [];
let flushing = false;
// 单文件单日上限（防极端刷屏撑爆磁盘），超出后丢弃并记一次丢弃计数
const MAX_QUEUE = 2000;
let dropped = 0;

/** 解析日志目录：优先 WEBTOOL_LOG_DIR，否则相对 cwd 的 ../workplace/logs */
export function resolveLogDir(): string {
  if (process.env.WEBTOOL_LOG_DIR) return process.env.WEBTOOL_LOG_DIR;
  // 部署时可通过环境变量覆盖；默认与历史 eveLog 路径一致
  return join(process.cwd(), '..', 'workplace', 'logs');
}

/** 异步写入一条带前缀的调试日志（非阻塞） */
export function debugLog(prefix: LogPrefix, msg: string): void {
  if (queue.length >= MAX_QUEUE) {
    dropped += 1;
    return;
  }
  queue.push({ prefix, msg, ts: new Date().toISOString() });
  void flushQueue();
}

async function flushQueue(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    while (queue.length > 0) {
      // 批量取出，减少 await 次数
      const batch = queue.splice(0, 64);
      const byDay = new Map<string, string[]>();
      for (const item of batch) {
        const day = item.ts.slice(0, 10);
        const line = `${item.ts} [${item.prefix}] ${item.msg}\n`;
        const arr = byDay.get(day) ?? [];
        arr.push(line);
        byDay.set(day, arr);
      }
      const dir = resolveLogDir();
      try {
        await mkdir(dir, { recursive: true });
      } catch {
        /* 目录创建失败则本批丢弃 */
        continue;
      }
      for (const [day, lines] of byDay) {
        // 按前缀分流到不同文件，便于 grep；同时写一份 all 汇总
        const content = lines.join('');
        const allPath = join(dir, `webtool-${day}.log`);
        try {
          await appendFile(allPath, content, 'utf8');
        } catch {
          /* 写失败静默 */
        }
        // 按前缀再写一份，检索更快
        const grouped = new Map<string, string[]>();
        for (const line of lines) {
          const m = line.match(/\[(\w+)\]/);
          const p = m?.[1] ?? 'app';
          const g = grouped.get(p) ?? [];
          g.push(line);
          grouped.set(p, g);
        }
        for (const [p, glines] of grouped) {
          try {
            await appendFile(join(dir, `${p}-${day}.log`), glines.join(''), 'utf8');
          } catch {
            /* ignore */
          }
        }
      }
      if (dropped > 0) {
        try {
          const day = new Date().toISOString().slice(0, 10);
          await appendFile(
            join(dir, `webtool-${day}.log`),
            `${new Date().toISOString()} [app] debugLog dropped=${dropped} (queue overflow)\n`,
            'utf8',
          );
        } catch {
          /* ignore */
        }
        dropped = 0;
      }
    }
  } finally {
    flushing = false;
    // 若 flush 期间又有入队，继续刷
    if (queue.length > 0) void flushQueue();
  }
}

/** 测试/关闭前等待队列刷完 */
export async function flushDebugLog(): Promise<void> {
  // 自旋等待队列清空（最多 2s）
  const start = Date.now();
  while ((queue.length > 0 || flushing) && Date.now() - start < 2000) {
    await flushQueue();
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * T-011 / C-009 / D-003：一次性清空会话与消息，保留设备与 eve 接入配置。
 *
 * 清空：turn_locks、messages、sessions（pending 字段随 session 行删除）
 * 保留：devices、device_errors、device_supported_backends、device_models、setup_tokens、eve_services
 *
 * 用法（在 webtool 目录）：
 *   pnpm wipe:sessions              # 真正删除
 *   pnpm wipe:sessions -- --dry-run # 只统计，不写库
 *
 * 环境变量 DATABASE_URL 与主应用一致，默认 ./data/webtool.db
 */
import { sql } from 'drizzle-orm';
import { getDb, migrate, resetDb } from '../lib/db/client';
import {
  deviceErrors,
  deviceModels,
  devices,
  deviceSupportedBackends,
  eveServices,
  messages,
  sessions,
  setupTokens,
  turnLocks,
} from '../lib/db/schema';

/** 是否 dry-run：只读计数，不 DELETE */
const dryRun = process.argv.includes('--dry-run');

// drizzle sqlite 表对象；用 any 避免为一次性脚本引入复杂 From 泛型
async function countRows(table: any): Promise<number> {
  const db = await getDb();
  const [row] = await db.select({ c: sql<number>`count(*)` }).from(table);
  return Number(row?.c ?? 0);
}

async function main() {
  // 确保 schema 已就绪，避免空库或旧库缺表时报错
  await migrate();
  const db = await getDb();

  // 清空前快照：对照 schema 最终表清单
  const before = {
    turn_locks: await countRows(turnLocks),
    messages: await countRows(messages),
    sessions: await countRows(sessions),
    devices: await countRows(devices),
    device_errors: await countRows(deviceErrors),
    device_supported_backends: await countRows(deviceSupportedBackends),
    device_models: await countRows(deviceModels),
    setup_tokens: await countRows(setupTokens),
    eve_services: await countRows(eveServices),
  };

  console.log('[wipe-sessions-messages] mode:', dryRun ? 'dry-run' : 'execute');
  console.log('[wipe-sessions-messages] before:', before);

  if (!dryRun) {
    // turn_locks/messages 都有 FK → sessions，必须先删子表
    await db.delete(turnLocks);
    await db.delete(messages);
    await db.delete(sessions);
  }

  const after = {
    turn_locks: await countRows(turnLocks),
    messages: await countRows(messages),
    sessions: await countRows(sessions),
    devices: await countRows(devices),
    device_errors: await countRows(deviceErrors),
    device_supported_backends: await countRows(deviceSupportedBackends),
    device_models: await countRows(deviceModels),
    setup_tokens: await countRows(setupTokens),
    eve_services: await countRows(eveServices),
  };

  console.log('[wipe-sessions-messages] after:', after);

  // 安全断言：接入配置行数不得减少
  const preserved = [
    'devices',
    'device_errors',
    'device_supported_backends',
    'device_models',
    'setup_tokens',
    'eve_services',
  ] as const;
  for (const key of preserved) {
    if (after[key] !== before[key]) {
      throw new Error(
        `[wipe-sessions-messages] 保留表 ${key} 行数变化: ${before[key]} → ${after[key]}`,
      );
    }
  }

  if (!dryRun) {
    if (after.turn_locks !== 0 || after.messages !== 0 || after.sessions !== 0) {
      throw new Error(
        `[wipe-sessions-messages] 清空失败: turn_locks=${after.turn_locks} messages=${after.messages} sessions=${after.sessions}`,
      );
    }
  }

  console.log(
    dryRun
      ? '[wipe-sessions-messages] dry-run 完成（未删除）'
      : '[wipe-sessions-messages] 已清空 sessions/messages，接入配置已保留',
  );

  await resetDb();
}

main().catch(async (err) => {
  console.error('[wipe-sessions-messages] failed:', err);
  try {
    await resetDb();
  } catch {
    /* ignore */
  }
  process.exit(1);
});

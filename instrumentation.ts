import { migrate } from './lib/db/client';
import { ensureSeed } from './lib/db/seed';

export async function register() {
  // 确保在Next.js启动时运行迁移 + 种子(预置默认 eve 服务)
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await migrate();
    await ensureSeed();
  }
}
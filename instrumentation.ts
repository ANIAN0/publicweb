import { migrate } from './lib/db/migrate';

export async function register() {
  // 确保在Next.js启动时运行迁移
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await migrate();
  }
}
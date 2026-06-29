import { createClient, Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import * as schema from './schema';

declare global {
  var __dbClient: Client | undefined;
  var __db: ReturnType<typeof drizzle<typeof schema>> | undefined;
}

export function getDb() {
  if (!global.__db) {
    const url = process.env.DATABASE_URL || 'file:./data/webtool.db';
    global.__dbClient = createClient({ url });
    global.__db = drizzle(global.__dbClient, { schema });
  }
  return global.__db;
}

export async function migrate() {
  const { migrate: drizzleMigrate } = await import('drizzle-orm/libsql/migrator');
  const db = getDb();
  await drizzleMigrate(db, { migrationsFolder: './drizzle' });
}

export function resetDb() {
  if (global.__dbClient) global.__dbClient.close();
  global.__dbClient = undefined;
  global.__db = undefined;
}
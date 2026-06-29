import { migrate as dbMigrate } from './client';

export async function migrate() {
  await dbMigrate();
}
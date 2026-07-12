import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';
import { devices, deviceSupportedBackends } from '@/lib/db/schema';
import { inArray } from 'drizzle-orm';

export async function GET() {
  const db = await getDb();
  const allDevices = await db.select().from(devices);

  if (allDevices.length === 0) {
    return NextResponse.json([]);
  }

  // APP-007：一次 inArray 取全部 supported backends，消除 N+1
  const deviceIds = allDevices.map((d) => d.id);
  const allBackends = await db
    .select()
    .from(deviceSupportedBackends)
    .where(inArray(deviceSupportedBackends.deviceId, deviceIds));

  const backendsByDevice = new Map<string, string[]>();
  for (const row of allBackends) {
    const list = backendsByDevice.get(row.deviceId) ?? [];
    list.push(row.backend);
    backendsByDevice.set(row.deviceId, list);
  }

  const result = allDevices.map((device) => ({
    id: device.id,
    name: device.name,
    hostname: device.hostname,
    online: device.online,
    lastSeenAt: device.lastSeenAt,
    supportedBackends: backendsByDevice.get(device.id) ?? [],
  }));

  return NextResponse.json(result);
}

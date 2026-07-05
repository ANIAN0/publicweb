import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';
import { eveServices } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

// PATCH /api/eve-services/[id] —— 更新 eve 服务(name/host/model 任一)
export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = await request.json();
  const db = await getDb();
  await db.update(eveServices).set({
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.host !== undefined ? { host: body.host } : {}),
    ...(body.model !== undefined ? { model: body.model } : {}),
  }).where(eq(eveServices.id, id));
  return NextResponse.json({ ok: true });
}

// DELETE /api/eve-services/[id] —— 删除 eve 服务
export async function DELETE(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const db = await getDb();
  await db.delete(eveServices).where(eq(eveServices.id, id));
  return NextResponse.json({ ok: true });
}

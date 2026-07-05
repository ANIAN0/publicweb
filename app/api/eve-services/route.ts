import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';
import { eveServices } from '@/lib/db/schema';
import { ulid } from 'ulid';
import { desc } from 'drizzle-orm';

// GET /api/eve-services —— 列出所有 eve 服务端点
export async function GET() {
  const db = await getDb();
  const rows = await db.select().from(eveServices).orderBy(desc(eveServices.createdAt));
  return NextResponse.json(rows);
}

// POST /api/eve-services —— 添加 eve 服务(name + host + model,部署者填该服务绑定的模型)
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { name, host, model } = body;
  if (!name || !host || !model) {
    return NextResponse.json({ error: 'name, host, model are required' }, { status: 400 });
  }
  const db = await getDb();
  const id = ulid();
  const now = new Date();
  await db.insert(eveServices).values({ id, name, host, model, createdAt: now });
  return NextResponse.json({ id, name, host, model, online: false, createdAt: now }, { status: 201 });
}

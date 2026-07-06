import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';
import { eveServices } from '@/lib/db/schema';
import { ulid } from 'ulid';
import { desc } from 'drizzle-orm';
import { validateAuth, maskAuth } from '@/lib/backends/eve-auth';

// GET /api/eve-services —— 列出所有 eve 服务端点(token 脱敏:不回显 bearer token / headers value)
export async function GET() {
  const db = await getDb();
  const rows = await db.select().from(eveServices).orderBy(desc(eveServices.createdAt));
  // 脱敏 authConfig:前端列表只看到 hasToken/headerNames,拿不到明文凭证
  const masked = rows.map((r) => {
    const m = maskAuth(r.authType, r.authConfig);
    return { ...r, authType: m.authType, authConfig: m.authConfig };
  });
  return NextResponse.json(masked);
}

// POST /api/eve-services —— 添加 eve 服务(name + host + model + 可选 authType/authConfig)
// 部署者填该服务绑定的模型;authType 默认 none,bearer/headers 时 authConfig 必填
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { name, host, model } = body;
  if (!name || !host || !model) {
    return NextResponse.json({ error: 'name, host, model are required' }, { status: 400 });
  }
  // 校验 auth(默认 none,向后兼容只传 name/host/model 的旧调用)
  const auth = validateAuth(body.authType ?? 'none', body.authConfig);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: 400 });
  }
  const db = await getDb();
  const id = ulid();
  const now = new Date();
  await db.insert(eveServices).values({
    id, name, host, model,
    authType: auth.authType, authConfig: auth.authConfig,
    createdAt: now,
  });
  return NextResponse.json({ id, name, host, model, authType: auth.authType, online: false, createdAt: now }, { status: 201 });
}

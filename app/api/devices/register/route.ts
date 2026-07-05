import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';
import { setupTokens, devices, deviceSupportedBackends } from '@/lib/db/schema';
import { hashToken, verifyToken, generateToken } from '@/lib/auth/token';
import { ulid } from 'ulid';
import { eq, and, gt } from 'drizzle-orm';

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { setupToken, hostname, supportedBackends } = body;

  if (!setupToken) {
    return NextResponse.json({ error: 'setupToken is required' }, { status: 400 });
  }

  const db = await getDb();
  const tokenHash = hashToken(setupToken);

  // 查找 setup token
  const [tokenRecord] = await db.select().from(setupTokens)
    .where(eq(setupTokens.tokenHash, tokenHash))
    .limit(1);

  if (!tokenRecord) {
    return NextResponse.json({ error: 'invalid token' }, { status: 401 });
  }

  // 检查是否过期
  if (new Date() > tokenRecord.expiresAt) {
    return NextResponse.json({ error: 'token expired' }, { status: 401 });
  }

  // 检查是否已使用
  if (tokenRecord.usedAt) {
    return NextResponse.json({ error: 'token used' }, { status: 401 });
  }

  // 标记 token 已使用
  await db.update(setupTokens)
    .set({ usedAt: new Date() })
    .where(eq(setupTokens.id, tokenRecord.id));

  // 创建 device
  const deviceId = ulid();
  const longLivedToken = generateToken();
  const longLivedTokenHash = hashToken(longLivedToken);
  const now = new Date();

  await db.insert(devices).values({
    id: deviceId,
    name: tokenRecord.deviceName,
    hostname: hostname || null,
    longLivedTokenHash,
    lastSeenAt: now,
    // register 仅是换取长期 token；真正的在线状态由 WS 网关在连接/断开时维护
    // （修复 REV-005-7：避免 register 后未连 WS 就误显在线）
    online: false,
    createdAt: now,
  });

  // 添加 supported backends
  if (supportedBackends && Array.isArray(supportedBackends)) {
    for (const backend of supportedBackends) {
      await db.insert(deviceSupportedBackends).values({
        deviceId,
        backend,
      });
    }
  }

  return NextResponse.json({ deviceId, longLivedToken }, { status: 201 });
}
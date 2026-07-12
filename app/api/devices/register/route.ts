import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/db/client';
import { setupTokens, devices, deviceSupportedBackends } from '@/lib/db/schema';
// APP-006：校验走 hashToken 查库，不用 verifyToken
import { hashToken, generateToken } from '@/lib/auth/token';
import { ulid } from 'ulid';
import { eq } from 'drizzle-orm';
import { parseJsonBody } from '@/lib/api/parse-json-body';

// APP-004：register body Zod
const registerBodySchema = z.object({
  setupToken: z.string().min(1),
  hostname: z.string().optional(),
  supportedBackends: z.array(z.string()).optional(),
});

export async function POST(request: NextRequest) {
  const parsed = await parseJsonBody(request, registerBodySchema);
  if (!parsed.ok) return parsed.response;
  const { setupToken, hostname, supportedBackends } = parsed.data;

  const db = await getDb();
  const tokenHash = hashToken(setupToken);

  const [tokenRecord] = await db.select().from(setupTokens)
    .where(eq(setupTokens.tokenHash, tokenHash))
    .limit(1);

  if (!tokenRecord) {
    return NextResponse.json({ error: 'invalid token' }, { status: 401 });
  }

  if (new Date() > tokenRecord.expiresAt) {
    return NextResponse.json({ error: 'token expired' }, { status: 401 });
  }

  if (tokenRecord.usedAt) {
    return NextResponse.json({ error: 'token used' }, { status: 401 });
  }

  await db.update(setupTokens)
    .set({ usedAt: new Date() })
    .where(eq(setupTokens.id, tokenRecord.id));

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
    online: false,
    createdAt: now,
  });

  // APP-010 同类：batch insert supported backends
  if (supportedBackends && supportedBackends.length > 0) {
    await db.insert(deviceSupportedBackends).values(
      supportedBackends.map((backend) => ({ deviceId, backend })),
    );
  }

  return NextResponse.json({ deviceId, longLivedToken }, { status: 201 });
}

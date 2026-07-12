import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';
import { setupTokens } from '@/lib/db/schema';
import { generateToken, hashToken } from '@/lib/auth/token';
import { ulid } from 'ulid';
import { derivePublicUrl } from '@/lib/api/public-url';
import { parseJsonBody } from '@/lib/api/parse-json-body';
import { z } from 'zod';

const setupTokenBodySchema = z.object({
  deviceName: z.string().min(1),
});

export async function POST(request: NextRequest) {
  // 额外接入 parseJsonBody（与 sessions/input/fork 统一校验路径）
  const parsed = await parseJsonBody(request, setupTokenBodySchema);
  if (!parsed.ok) return parsed.response;
  const { deviceName } = parsed.data;

  const token = generateToken();
  const tokenHash = hashToken(token);
  const id = ulid();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 24 小时有效

  const db = await getDb();
  await db.insert(setupTokens).values({
    id,
    tokenHash,
    deviceName,
    expiresAt,
    createdAt: now,
  });

  // APP-012：derivePublicUrl 抽到 lib，route 只拼命令
  const publicUrl = derivePublicUrl(request);
  const command = `webtool-client register --url ${publicUrl} --token ${token} --name ${deviceName}`;

  return NextResponse.json({ setupToken: token, expiresAt, command }, { status: 201 });
}

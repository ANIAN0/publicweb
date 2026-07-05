import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';
import { setupTokens } from '@/lib/db/schema';
import { generateToken, hashToken } from '@/lib/auth/token';
import { ulid } from 'ulid';

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { deviceName } = body;

  if (!deviceName) {
    return NextResponse.json({ error: 'deviceName is required' }, { status: 400 });
  }

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

  // 命令里的 webtool URL 必须反映真实部署形态：
  //   1. 优先环境变量 WEBTOOL_PUBLIC_URL（部署时显式配置最准）
  //   2. 其次 Origin 请求头（浏览器跨源请求会带，反向代理也会透传）
  //   3. 最后从 Request URL 自身解析 origin（兜底，且对单测注入的 plain Request 友好）
  // 这样新增设备对话框复制的命令一定能连到 webtool（修复 REV-005-13）。
  const derivePublicUrl = (req: NextRequest | Request): string => {
    const envUrl = process.env.WEBTOOL_PUBLIC_URL;
    if (envUrl) return envUrl;
    const origin = req.headers.get('origin');
    if (origin) return origin;
    try { return new URL(req.url).origin; }
    catch { return 'http://localhost:3000'; }
  };
  const publicUrl = derivePublicUrl(request);
  const command = `webtool-client register --url ${publicUrl} --token ${token} --name ${deviceName}`;

  return NextResponse.json({ setupToken: token, expiresAt, command }, { status: 201 });
}
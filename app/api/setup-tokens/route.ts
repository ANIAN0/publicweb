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
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 24 hours

  const db = getDb();
  await db.insert(setupTokens).values({
    id,
    tokenHash,
    deviceName,
    expiresAt,
    createdAt: now,
  });

  const command = `webtool-client register --url http://localhost:3000 --token ${token} --name ${deviceName}`;

  return NextResponse.json({ setupToken: token, expiresAt, command }, { status: 201 });
}
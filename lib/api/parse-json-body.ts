// APP-004：统一 Zod 解析 JSON body
import { NextResponse } from 'next/server';
import type { z } from 'zod';

export type ParseBodyOk<T> = { ok: true; data: T };
export type ParseBodyErr = { ok: false; response: NextResponse };

/**
 * 解析 request.json() 并用 zod schema 校验。
 * 失败返回 400 NextResponse，成功返回 data。
 */
export async function parseJsonBody<T extends z.ZodTypeAny>(
  request: Request,
  schema: T,
): Promise<ParseBodyOk<z.infer<T>> | ParseBodyErr> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return {
      ok: false,
      response: NextResponse.json({ error: 'invalid JSON body' }, { status: 400 }),
    };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'validation failed', details: parsed.error.issues },
        { status: 400 },
      ),
    };
  }
  return { ok: true, data: parsed.data };
}

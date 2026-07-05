import { NextRequest, NextResponse } from 'next/server';
import { getBackendAdapter } from '@/lib/backends/router';

// GET /api/backends/[backend]/targets —— 返回该后端的执行端点列表(自带 models)
// local 返回设备(多模型),eveagent 返回 eve 服务(单模型)。差异在适配器内。
export async function GET(_request: NextRequest, context: { params: Promise<{ backend: string }> }) {
  const { backend } = await context.params;
  try {
    const adapter = getBackendAdapter(backend);
    const targets = await adapter.listTargets();
    return NextResponse.json(targets);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'unknown' }, { status: 400 });
  }
}

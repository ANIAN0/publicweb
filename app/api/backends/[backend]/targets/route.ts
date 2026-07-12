import { NextRequest, NextResponse } from 'next/server';
import { getBackendAdapter } from '@/lib/backends/router';

// GET /api/backends/[backend]/targets —— 返回该后端的执行端点列表(自带 models)
// local 返回设备(多模型),eveagent 返回 eve 服务(单模型)。差异在适配器内。
export async function GET(_request: NextRequest, context: { params: Promise<{ backend: string }> }) {
  const { backend } = await context.params;
  // APP-019：未知 backend → 400；listTargets 运行时失败 → 500
  let adapter;
  try {
    adapter = getBackendAdapter(backend);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : `Unsupported backend: ${backend}`;
    return NextResponse.json({ error: message }, { status: 400 });
  }
  try {
    const targets = await adapter.listTargets();
    return NextResponse.json(targets);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'listTargets failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

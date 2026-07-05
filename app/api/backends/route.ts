import { NextResponse } from 'next/server';
import { listBackends } from '@/lib/backends/router';

// GET /api/backends —— 返回所有后端描述符,前端数据驱动渲染后端卡片
export async function GET() {
  return NextResponse.json(listBackends());
}

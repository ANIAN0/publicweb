import Link from 'next/link';

export default function Home() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-8">
      <h1 className="text-2xl font-bold mb-8">通用 ChatUI</h1>
      <p className="text-zinc-600 mb-8">暂无会话</p>
      <div className="flex gap-4">
        <Link
          href="/sessions/new"
          className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
        >
          + 新会话
        </Link>
        <Link
          href="/devices"
          className="px-4 py-2 border rounded hover:bg-zinc-100"
        >
          设备管理
        </Link>
      </div>
    </div>
  );
}
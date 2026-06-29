'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function NewSession() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  const handleCreate = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ backend: 'eveagent', model: 'claude-sonnet-4.6' }),
      });
      if (response.ok) {
        const data = await response.json();
        router.push(`/sessions/${data.id}`);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-8">
      <h1 className="text-2xl font-bold mb-8">新建会话</h1>
      <button
        onClick={handleCreate}
        disabled={loading}
        className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 disabled:opacity-50"
      >
        {loading ? '创建中...' : 'Eveagent 会话'}
      </button>
    </div>
  );
}
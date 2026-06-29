'use client';

import { useState } from 'react';

interface Props {
  onClose: () => void;
  onDeviceAdded: () => void;
}

export default function AddDeviceDialog({ onClose, onDeviceAdded }: Props) {
  const [deviceName, setDeviceName] = useState('');
  const [loading, setLoading] = useState(false);
  const [token, setToken] = useState('');
  const [command, setCommand] = useState('');

  const handleGenerate = async () => {
    if (!deviceName.trim()) return;
    setLoading(true);
    try {
      const response = await fetch('/api/setup-tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceName }),
      });
      if (response.ok) {
        const data = await response.json();
        setToken(data.setupToken);
        setCommand(data.command);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center">
      <div className="bg-white p-6 rounded-lg w-96">
        <h2 className="text-lg font-bold mb-4">添加设备</h2>
        
        {!token ? (
          <>
            <input
              type="text"
              value={deviceName}
              onChange={(e) => setDeviceName(e.target.value)}
              placeholder="设备名称"
              className="w-full p-2 border rounded mb-4"
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={onClose}
                className="px-4 py-2 border rounded"
              >
                取消
              </button>
              <button
                onClick={handleGenerate}
                disabled={loading || !deviceName.trim()}
                className="px-4 py-2 bg-blue-500 text-white rounded disabled:opacity-50"
              >
                {loading ? '生成中...' : '生成 Token'}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-zinc-600 mb-2">请在本地 client 运行以下命令：</p>
            <pre className="bg-zinc-100 p-2 rounded text-xs overflow-x-auto mb-4">
              {command}
            </pre>
            <p className="text-xs text-zinc-500 mb-4">
              Token 会在 24 小时后过期。
            </p>
            <div className="flex justify-end">
              <button
                onClick={onDeviceAdded}
                className="px-4 py-2 bg-blue-500 text-white rounded"
              >
                完成
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
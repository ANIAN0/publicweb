'use client';

import { useEffect, useState } from 'react';
import AddDeviceDialog from './_components/AddDeviceDialog';

interface Device {
  id: string;
  name: string;
  hostname: string;
  online: boolean;
  lastSeenAt: string;
  supportedBackends: string[];
}

export default function DevicesPage() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [showDialog, setShowDialog] = useState(false);

  const fetchDevices = async () => {
    const response = await fetch('/api/devices');
    const data = await response.json();
    setDevices(data);
  };

  useEffect(() => {
    fetchDevices();
  }, []);

  return (
    <div className="p-8">
      <div className="flex justify-between items-center mb-8">
        <h1 className="text-2xl font-bold">设备管理</h1>
        <button
          onClick={() => setShowDialog(true)}
          className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
        >
          添加设备
        </button>
      </div>

      <div className="grid gap-4">
        {devices.map((device) => (
          <div key={device.id} className="p-4 border rounded-lg">
            <div className="flex justify-between items-center">
              <div>
                <h2 className="font-semibold">{device.name}</h2>
                <p className="text-sm text-zinc-600">{device.hostname}</p>
              </div>
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${device.online ? 'bg-green-500' : 'bg-red-500'}`}></span>
                <span className="text-sm">{device.online ? '在线' : '离线'}</span>
              </div>
            </div>
            <div className="mt-2 text-sm text-zinc-500">
              支持后端: {device.supportedBackends.join(', ')}
            </div>
          </div>
        ))}
        {devices.length === 0 && (
          <p className="text-zinc-500">暂无设备</p>
        )}
      </div>

      {showDialog && (
        <AddDeviceDialog
          onClose={() => setShowDialog(false)}
          onDeviceAdded={() => {
            setShowDialog(false);
            fetchDevices();
          }}
        />
      )}
    </div>
  );
}
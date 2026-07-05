'use client';
// 首页:历史会话列表 + 后端筛选 + 标题搜索 + 重命名/删除 + 空状态
// 设计参考:open-agents 的 session-list(按日期分组、极简语义色、hover 高亮)+ tool sidebar(hover 才显操作)
// 数据:GET /api/sessions(filter: backend / q);操作:PATCH /api/sessions/[id](userTitle)、DELETE(软删)
import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  Plus,
  Settings,
  Search,
  Pencil,
  Trash2,
  MoreHorizontal,
  MessageSquare,
} from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';

// 列表项类型,与 GET /api/sessions 返回对齐
interface SessionItem {
  id: string;
  backend: 'eveagent' | 'claudecode' | 'pi';
  model: string;
  title: string | null;
  userTitle: string | null;
  deviceId: string | null;
  deviceName: string | null;
  messageCount: number;
  lastActiveAt: string | number; // Date 经 JSON 序列化后变成 string
}

type BackendFilter = '' | 'eveagent' | 'claudecode' | 'pi';

// 后端显示名(徽标 + 筛选 chip 共用)
const BACKEND_LABEL: Record<Exclude<BackendFilter, ''>, string> = {
  eveagent: 'Eveagent',
  claudecode: 'Claude Code',
  pi: 'Pi',
};

// 按日期分组:今天 / 昨天 / 具体日期(参考 open-agents session-list 的分组逻辑)
function groupByDate(items: SessionItem[]): Map<string, SessionItem[]> {
  const groups = new Map<string, SessionItem[]>();
  const now = new Date();
  const todayStr = now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toDateString();
  for (const s of items) {
    const d = new Date(s.lastActiveAt);
    // 分组键:今天/昨天用相对词,其余用本地化日期(跨年才显示年份)
    let key: string;
    if (d.toDateString() === todayStr) key = '今天';
    else if (d.toDateString() === yesterdayStr) key = '昨天';
    else
      key = d.toLocaleDateString('zh-CN', {
        month: 'long',
        day: 'numeric',
        year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
      });
    const arr = groups.get(key) ?? [];
    arr.push(s);
    groups.set(key, arr);
  }
  return groups;
}

// 相对时间格式化:刚刚 / N 分钟前 / N 小时前 / N 天前 / 具体日期
function formatRelative(date: Date): string {
  const diff = Date.now() - date.getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 7) return `${day} 天前`;
  return date.toLocaleDateString('zh-CN');
}

export default function Home() {
  const [items, setItems] = useState<SessionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [backend, setBackend] = useState<BackendFilter>('');
  // 输入框实时值与 debounce 后的生效值分离,避免每次按键都发请求
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');

  // 搜索 debounce 250ms:qInput 变化后延迟 250ms 才更新生效的 q
  useEffect(() => {
    const t = setTimeout(() => setQ(qInput.trim()), 250);
    return () => clearTimeout(t);
  }, [qInput]);

  // 拉数据:backend 或 q 变化时重新请求
  const reload = () => {
    const ac = new AbortController();
    const params = new URLSearchParams();
    if (backend) params.set('backend', backend);
    if (q) params.set('q', q);
    setLoading(true);
    fetch(`/api/sessions?${params.toString()}`, { signal: ac.signal })
      .then((r) => r.json() as Promise<SessionItem[]>)
      .then((data) => setItems(data))
      .catch((err) => {
        if (err.name !== 'AbortError') console.error('list sessions error:', err);
      })
      .finally(() => setLoading(false));
    return () => ac.abort();
  };
  useEffect(reload, [backend, q]);

  const groups = groupByDate(items);

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      {/* 顶部:标题 + 操作按钮 */}
      <header className="flex items-center justify-between px-6 py-4">
        <span className="text-lg font-semibold">通用 ChatUI</span>
        <div className="flex items-center gap-2">
          {/* 用 buttonVariants 给 Link 加按钮样式,避免 a/button 嵌套 */}
          <Link
            href="/sessions/new"
            className={buttonVariants({ variant: 'default', size: 'sm' })}
          >
            <Plus className="size-4" /> 新会话
          </Link>
          <Link
            href="/devices"
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
          >
            <Settings className="size-4" /> 设备管理
          </Link>
        </div>
      </header>

      {/* 筛选 + 搜索 */}
      <div className="flex flex-wrap items-center gap-2 px-6 pb-4">
        <div className="flex gap-1">
          <Button
            variant={backend === '' ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setBackend('')}
          >
            全部
          </Button>
          {(Object.keys(BACKEND_LABEL) as Array<keyof typeof BACKEND_LABEL>).map(
            (b) => (
              <Button
                key={b}
                variant={backend === b ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => setBackend(b)}
              >
                {BACKEND_LABEL[b]}
              </Button>
            ),
          )}
        </div>
        {/* 搜索框:左侧 Search 图标绝对定位,Input 左 padding 留出空间 */}
        <div className="relative min-w-[200px] max-w-sm flex-1">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            placeholder="搜索标题..."
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            className="pl-8"
          />
        </div>
      </div>

      {/* 列表 / 空状态 / loading */}
      <main className="flex-1 overflow-y-auto px-6 pb-8">
        {loading ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            加载中...
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
            <MessageSquare className="size-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">
              {q || backend ? '没有匹配的会话' : '暂无会话,点击"新会话"开始'}
            </p>
          </div>
        ) : (
          <div className="mx-auto max-w-3xl space-y-6">
            {Array.from(groups.entries()).map(([key, groupItems]) => (
              <div key={key}>
                {/* 分组标题:小号、大写、字间距、弱化色 */}
                <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  {key}
                </h3>
                <div className="space-y-0.5">
                  {groupItems.map((s) => (
                    <SessionRow key={s.id} item={s} onChanged={reload} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

// 单条会话行:hover 高亮、点击进会话、⋯ 菜单(重命名/删除)、删除二次确认
function SessionRow({
  item,
  onChanged,
}: {
  item: SessionItem;
  onChanged: () => void;
}) {
  // 显示优先级:userTitle > title > "新会话"
  const displayTitle = item.userTitle ?? item.title ?? '新会话';
  // 重命名 inline input 状态
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(item.userTitle ?? '');
  // 删除确认对话框状态
  const [confirmDelete, setConfirmDelete] = useState(false);
  // 操作中 loading(防重复点击)
  const [busy, setBusy] = useState(false);

  // 提交重命名
  const submitRename = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/sessions/${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userTitle: renameValue.trim() || null }),
      });
      if (!res.ok) {
        console.error('rename failed:', await res.text());
        return;
      }
      setRenaming(false);
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  // 提交删除
  const confirmDeleteAction = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/sessions/${item.id}`, { method: 'DELETE' });
      if (!res.ok) {
        console.error('delete failed:', await res.text());
        setConfirmDelete(false);
        return;
      }
      setConfirmDelete(false);
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="group flex items-center justify-between gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-muted/50">
        <Link href={`/sessions/${item.id}`} className="min-w-0 flex-1">
          {renaming ? (
            // 重命名态:inline 输入框 + 保存/取消,Enter 提交 Esc 取消
            <div
              className="flex items-center gap-2"
              onClick={(e) => e.preventDefault()}
            >
              <Input
                autoFocus
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitRename();
                  else if (e.key === 'Escape') {
                    setRenaming(false);
                    setRenameValue(item.userTitle ?? '');
                  }
                }}
                disabled={busy}
                className="h-7"
              />
              <Button size="xs" onClick={submitRename} disabled={busy}>
                保存
              </Button>
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  setRenaming(false);
                  setRenameValue(item.userTitle ?? '');
                }}
                disabled={busy}
              >
                取消
              </Button>
            </div>
          ) : (
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <p className="truncate font-medium text-foreground">
                  {displayTitle}
                </p>
                <Badge variant="secondary" className="shrink-0">
                  {BACKEND_LABEL[item.backend]}
                </Badge>
              </div>
              {/* 元信息:设备 · 消息数 · 相对时间 */}
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {item.deviceName && <span>{item.deviceName} · </span>}
                <span>
                  {item.messageCount} 条 · {formatRelative(new Date(item.lastActiveAt))}
                </span>
              </p>
            </div>
          )}
        </Link>

        {/* ⋯ 菜单:仅非重命名态显示。Trigger 用 buttonVariants 渲染为 ghost 图标按钮 */}
        {!renaming && (
          <DropdownMenu>
            <DropdownMenuTrigger
              className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
            >
              <MoreHorizontal className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setRenaming(true)}>
                <Pencil className="size-4" /> 重命名
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {/* 删除项:红色文字 + hover 红底 */}
              <DropdownMenuItem
                className="text-destructive focus:bg-destructive/10 focus:text-destructive"
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 className="size-4" /> 删除
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {/* 删除二次确认:用 shadcn Dialog 替代旧的 ConfirmDialog */}
      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除会话?</DialogTitle>
            <DialogDescription>
              确定要删除「{displayTitle}」吗?此操作不可恢复。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmDelete(false)}
              disabled={busy}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDeleteAction}
              disabled={busy}
            >
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

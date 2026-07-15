'use client';
// 首页:历史会话列表 + 后端筛选 + 标题搜索 + 重命名/删除/批量删除 + 空状态
// 设计参考:open-agents 的 session-list(按日期分组、极简语义色、hover 高亮)+ tool sidebar(hover 才显操作)
// 数据:GET /api/sessions(filter: backend / q);操作:PATCH /api/sessions/[id](userTitle)、DELETE(软删)、POST bulk-delete
import Link from 'next/link';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Plus,
  Settings,
  Search,
  Pencil,
  Trash2,
  Eraser,
  MoreHorizontal,
  MessageSquare,
  Cloud,
} from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { formatRelative } from '@/lib/utils';
import { BACKEND_LABEL } from '@/lib/backends/labels';
import { SkeletonList } from '@/components/layout/Skeleton';
import { EmptyState } from '@/components/layout/EmptyState';
import { ErrorBanner } from '@/components/layout/ErrorBanner';

// 列表项类型,与 GET /api/sessions 返回对齐
interface SessionItem {
  id: string;
  backend: 'eveagent' | 'claudecode' | 'pi';
  model: string;
  title: string | null;
  userTitle: string | null;
  targetId: string | null;
  targetName: string | null;
  // 已删 target 标记:true 表示 target 已被删除（设备或 eve 服务被删后,sessions 表保留历史会话）
  targetDeleted?: boolean;
  messageCount: number;
  lastActiveAt: string | number; // Date 经 JSON 序列化后变成 string
}

type BackendFilter = '' | 'eveagent' | 'claudecode' | 'pi';

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

export default function Home() {
  const [items, setItems] = useState<SessionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [backend, setBackend] = useState<BackendFilter>('');
  // 输入框实时值与 debounce 后的生效值分离,避免每次按键都发请求
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  // 多选：仅当前列表可见项；批量软删走 POST /api/sessions/bulk-delete
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);

  // 搜索 debounce 250ms:qInput 变化后延迟 250ms 才更新生效的 q
  useEffect(() => {
    const t = setTimeout(() => setQ(qInput.trim()), 250);
    return () => clearTimeout(t);
  }, [qInput]);

  // A2: reload 改用 useCallback 稳定引用；AbortController 用 ref 持有以便 cleanup 触发最新请求的 abort
  // 旧实现 reload 是 inline 闭包，每次渲染新引用 → useEffect(reload, [backend, q]) 实际每次 render 都重跑
  const abortRef = useRef<AbortController | null>(null);
  const reload = useCallback(() => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    const params = new URLSearchParams();
    if (backend) params.set('backend', backend);
    if (q) params.set('q', q);
    setLoading(true);
    setError(null);
    fetch(`/api/sessions?${params.toString()}`, { signal: ac.signal })
      .then((r) => r.json() as Promise<SessionItem[]>)
      .then((data) => {
        // 已被 abort（用户在请求未返回时切换 backend/q）则丢弃结果
        if (abortRef.current !== ac) return;
        setItems(data);
        // 刷新后剔除已不在列表中的选中（含刚删除的）
        const alive = new Set(data.map((s) => s.id));
        setSelectedIds((prev) => {
          const next = new Set<string>();
          for (const id of prev) {
            if (alive.has(id)) next.add(id);
          }
          return next;
        });
      })
      .catch((err) => {
        if (err.name === 'AbortError') return; // 主动取消，非错误
        if (abortRef.current !== ac) return;
        setError('加载会话失败,请重试');
      })
      .finally(() => {
        if (abortRef.current === ac) setLoading(false);
      });
  }, [backend, q]);

  useEffect(() => {
    reload();
    return () => {
      abortRef.current?.abort();
    };
  }, [reload]);

  const groups = groupByDate(items);
  const visibleIds = useMemo(() => items.map((s) => s.id), [items]);
  const selectedCount = selectedIds.size;
  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));

  const toggleOne = useCallback((id: string, checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const selectAllVisible = useCallback(() => {
    setSelectedIds(new Set(visibleIds));
  }, [visibleIds]);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const invertSelection = useCallback(() => {
    setSelectedIds((prev) => {
      const next = new Set<string>();
      for (const id of visibleIds) {
        if (!prev.has(id)) next.add(id);
      }
      return next;
    });
  }, [visibleIds]);

  const confirmBulkDeleteAction = async () => {
    if (selectedCount === 0) return;
    setBulkBusy(true);
    try {
      const ids = [...selectedIds];
      const res = await fetch('/api/sessions/bulk-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) {
        console.error('bulk-delete failed:', await res.text());
        setConfirmBulkDelete(false);
        return;
      }
      setConfirmBulkDelete(false);
      setSelectedIds(new Set());
      reload();
    } finally {
      setBulkBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      {/* 顶部:标题 + 操作按钮 */}
      <header className="sticky top-0 z-10 flex items-center justify-between border-b bg-background px-6 py-4">
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
          <Link
            href="/eve-services"
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
          >
            <Cloud className="size-4" /> Eve 服务
          </Link>
        </div>
      </header>

      {/* 筛选 + 搜索 + 批量操作（sticky，滚动时仍可见） */}
      <div className="sticky top-[65px] z-10 space-y-2 border-b bg-background/95 px-6 pt-4 pb-3 backdrop-blur supports-backdrop-filter:bg-background/80">
        <div className="flex flex-wrap items-center gap-2">
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

        {/* 多选：未选时只留轻量全选；有选中时整行操作条（左信息/右删除） */}
        {!loading && !error && items.length > 0 && (
          selectedCount === 0 ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Checkbox
                checked={false}
                onCheckedChange={(c) => {
                  if (c) selectAllVisible();
                }}
                aria-label="全选当前列表"
              />
              <button
                type="button"
                className="hover:text-foreground"
                onClick={selectAllVisible}
              >
                全选本页（{visibleIds.length}）
              </button>
              <span className="text-xs">勾选左侧可批量删除</span>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Checkbox
                  checked={allVisibleSelected}
                  onCheckedChange={(c) => {
                    if (c) selectAllVisible();
                    else clearSelection();
                  }}
                  aria-label="全选当前列表"
                />
                <span className="font-medium tabular-nums">
                  已选 {selectedCount}
                  <span className="font-normal text-muted-foreground">
                    {' '}/ {visibleIds.length}
                  </span>
                </span>
                <span className="text-muted-foreground">·</span>
                <Button variant="ghost" size="sm" className="h-7 px-2" onClick={selectAllVisible}>
                  全选
                </Button>
                <Button variant="ghost" size="sm" className="h-7 px-2" onClick={invertSelection}>
                  反选
                </Button>
                <Button variant="ghost" size="sm" className="h-7 px-2" onClick={clearSelection}>
                  取消
                </Button>
              </div>
              <Button
                variant="destructive"
                size="sm"
                disabled={bulkBusy}
                onClick={() => setConfirmBulkDelete(true)}
              >
                <Trash2 className="size-4" />
                删除选中（{selectedCount}）
              </Button>
            </div>
          )
        )}
      </div>

      {/* 列表 / 空状态 / loading */}
      <main className="min-h-0 flex-1 overflow-y-auto px-6 pb-8 pt-4">
        {error ? (
          <ErrorBanner message={error} onRetry={reload} retrying={loading} />
        ) : loading ? (
          <SkeletonList count={5} />
        ) : items.length === 0 ? (
          <EmptyState
            icon={<MessageSquare className="size-8" />}
            title={q || backend ? '没有匹配的会话' : '暂无会话'}
            description={q || backend ? '试试调整筛选或搜索词' : '点击下方按钮开始第一次对话'}
            action={
              q || backend ? (
                <Button variant="outline" size="sm" onClick={() => { setBackend(''); setQInput(''); }}>
                  清空筛选
                </Button>
              ) : (
                <Link href="/sessions/new" className={buttonVariants({ variant: 'default', size: 'sm' })}>
                  <Plus className="size-4" /> 新会话
                </Link>
              )
            }
          />
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
                    <SessionRow
                      key={s.id}
                      item={s}
                      onChanged={reload}
                      selected={selectedIds.has(s.id)}
                      onSelectedChange={toggleOne}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      <ConfirmDialog
        open={confirmBulkDelete}
        onOpenChange={setConfirmBulkDelete}
        title={`删除选中的 ${selectedCount} 个会话?`}
        description="将软删除选中会话（与单条删除相同）。历史消息保留在数据库中，列表中不再显示。此操作不可从 UI 恢复。"
        confirmText="删除选中"
        busy={bulkBusy}
        onConfirm={confirmBulkDeleteAction}
      />
    </div>
  );
}

// 单条会话行:多选 Checkbox + hover 高亮、点击进会话、⋯ 菜单(重命名/删除)、删除二次确认
// A3: 用 React.memo 包裹；父组件 onChanged 由 useCallback 稳定（A2），item 仅在该行变更时换引用，
// selected 来自父组件 selectedIds.has(id)；onSelectedChange 接受 (id, checked) 直接绑定父级 toggleOne
// → 避免父组件 .map 内 inline arrow 让 memo 失效
const SessionRow = memo(function SessionRow({
  item,
  onChanged,
  selected,
  onSelectedChange,
}: {
  item: SessionItem;
  onChanged: () => void;
  selected: boolean;
  onSelectedChange: (id: string, checked: boolean) => void;
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
      <div
        className={`group grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-muted/50 ${
          selected ? 'bg-muted/40' : ''
        }`}
      >
        {/* 多选：阻止冒泡，避免点选跳进会话；与标题行垂直居中对齐 */}
        <div
          className="flex shrink-0 items-center self-center pl-1"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <Checkbox
            checked={selected}
            onCheckedChange={(checked) => onSelectedChange(item.id, checked === true)}
            aria-label={`选择 ${displayTitle}`}
          />
        </div>

        <Link href={`/sessions/${item.id}`} className="min-w-0">
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
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <p className="truncate font-medium text-foreground">
                  {displayTitle}
                </p>
                <Badge variant="secondary" className="shrink-0">
                  {BACKEND_LABEL[item.backend]}
                </Badge>
              </div>
              {/* 元信息:设备 · 消息数 · 相对时间 */}
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {item.targetDeleted ? (
                  // target 已删:显示灰色 Badge（按 backend 区分文案）
                  <Badge variant="secondary" className="mr-1.5 text-xs">
                    {item.backend === 'eveagent' ? '已删除服务' : '已删除设备'}
                  </Badge>
                ) : item.targetName ? (
                  <span>{item.targetName} · </span>
                ) : null}
                <span>
                  {item.messageCount} 条 · {formatRelative(new Date(item.lastActiveAt))}
                </span>
              </p>
            </div>
          )}
        </Link>

        {/* ⋯ 菜单：单条重命名 / 删除（target 已删时文案为「清理」） */}
        {!renaming && (
          <DropdownMenu>
            <DropdownMenuTrigger
              className={buttonVariants({
                variant: 'ghost',
                size: 'icon-sm',
                className:
                  'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100',
              })}
            >
              <MoreHorizontal className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setRenaming(true)}>
                <Pencil className="size-4" /> 重命名
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {/* target 已删：清理；否则删除。同一入口，避免菜单里两项并存 */}
              <DropdownMenuItem
                className="text-destructive focus:bg-destructive/10 focus:text-destructive"
                onClick={() => setConfirmDelete(true)}
              >
                {item.targetDeleted ? (
                  <>
                    <Eraser className="size-4" /> 清理
                  </>
                ) : (
                  <>
                    <Trash2 className="size-4" /> 删除
                  </>
                )}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {/* 删除/清理二次确认:targetDeleted=true 时显示"清理"文案,否则"删除" */}
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={item.targetDeleted ? '清理已删 target 的会话?' : '删除会话?'}
        description={item.targetDeleted
          ? `「${displayTitle}」关联的 target 已被删除,此操作仅清理该会话记录,历史消息保留在数据库中。`
          : `确定要删除「${displayTitle}」吗?此操作不可恢复。`}
        confirmText={item.targetDeleted ? '清理' : '删除'}
        busy={busy}
        onConfirm={confirmDeleteAction}
      />
    </>
  );
});

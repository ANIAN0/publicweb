import { WebtoolEvent, InputResponse } from '../protocol/events';
// LIB-003/016：ChatMessage 定义在 protocol/messages，此处 re-export 保持现有 import 路径
export type { ChatMessage, ToolCall, ToolResult } from '../protocol/messages';
import type { ChatMessage } from '../protocol/messages';

export interface ModelInfo { id: string; label: string; isDefault?: boolean }

// 执行端点:后端运行的一个具体目标(local=设备, eveagent=eve 服务)
export interface ExecutionTarget {
  id: string;
  name: string;
  online: boolean;
  models: ModelInfo[];               // 该端点支持的模型(local 多个, eveagent 单个)
  meta?: Record<string, string>;     // device: hostname; eve_service: host url
}

// 后端描述符:前端数据驱动渲染后端卡片,不硬编码后端列表
export interface BackendDescriptor {
  id: 'eveagent' | 'claudecode' | 'pi';
  label: string;
  description: string;
}

/** 用户消息附件引用（已落盘，send 时透传给后端） */
export interface MessageAttachmentRef {
  id: string;
  filename: string;
  mediaType: string;
  size?: number;
  url?: string;
}

export interface BackendAdapter extends BackendDescriptor {
  /** 列出该后端可用的执行端点(自带 models);前端按 models 数量决定是否显示模型步 */
  listTargets(): Promise<ExecutionTarget[]>;
  /** 创建或续接一个 session;targetId 对 local 是 device.id,对 eveagent 是 eve_service.id */
  startSession(opts: { sessionId: string; model: string; targetId: string; history: ChatMessage[]; cwd?: string }): Promise<void>;
  /**
   * 发送一条用户消息（不等待响应）。
   * HITL 走 respondInput；附件走 opts.attachments（已上传到 server 的引用）。
   */
  /**
   * 发送用户消息。opts.runId 可选：若调用方已分配则传入；否则 local 路径由 LocalBackend 在下发前分配。
   * runId 仅中心分配，执行端不得自造。
   */
  send(
    sessionId: string,
    content: string,
    opts?: { attachments?: MessageAttachmentRef[]; runId?: string; model?: string },
  ): Promise<void>;
  /**
   * 回答 HITL（ask_question / tool-approval / AskUserQuestion）。
   * 与 send 语义分离：不插 user 消息，只续接当前 turn 的输入请求。
   * responses 可多项（多 request 并行回答）；各后端 narrow 自己的形态。
   * opts.runId：调用方已 withTurnLock 时传入（与 send 一致）；否则后端可自取/新建。
   */
  respondInput(
    sessionId: string,
    responses: InputResponse[],
    opts?: { runId?: string },
  ): Promise<void>;
  /** 主动停止当前 turn（不 kill agent 进程） */
  stop(sessionId: string): Promise<void>;
  /** 订阅一个 session 的事件 */
  // LIB-015：EventBus 始终传入 eventId（number），与实现一致；可选的是 sinceEventId
  onEvent(sessionId: string, cb: (e: WebtoolEvent, eventId: number, runId?: string) => void, sinceEventId?: number): () => void;
  /** reload 后追回崩溃窗口遗漏事件(eveagent 实现,local 无);SSE 连接时触发 */
  resume?(sessionId: string, signal: AbortSignal): Promise<void>;
  // 预留:per-target 模型切换(内嵌 eveagent 改文件重启场景),当前不实现,场景来时加
  // switchModel?(targetId: string, model: string): Promise<void>;
}

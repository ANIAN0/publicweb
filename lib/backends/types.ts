import { WebtoolEvent, InputResponse } from '../protocol/events';

export interface ModelInfo { id: string; label: string; isDefault?: boolean }
export interface ChatMessage { role: 'user' | 'assistant' | 'tool'; content: string; toolCalls?: ToolCall[]; toolResults?: ToolResult[] }

export interface ToolCall { id: string; name: string; input: unknown }
export interface ToolResult { toolCallId: string; output: string; isError?: boolean }

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

export interface BackendAdapter extends BackendDescriptor {
  /** 列出该后端可用的执行端点(自带 models);前端按 models 数量决定是否显示模型步 */
  listTargets(): Promise<ExecutionTarget[]>;
  /** 创建或续接一个 session;targetId 对 local 是 device.id,对 eveagent 是 eve_service.id */
  startSession(opts: { sessionId: string; model: string; targetId: string; history: ChatMessage[]; cwd?: string }): Promise<void>;
  /** 发送一条用户消息（不等待响应）；opts.inputResponses 用于回答 HITL ask_question（eve 路线） */
  send(sessionId: string, content: string, opts?: { inputResponses?: InputResponse[] }): Promise<void>;
  /** 主动停止当前 turn（不 kill agent 进程） */
  stop(sessionId: string): Promise<void>;
  /** 订阅一个 session 的事件 */
  onEvent(sessionId: string, cb: (e: WebtoolEvent, eventId?: number) => void, sinceEventId?: number): () => void;
  /** reload 后追回崩溃窗口遗漏事件(eveagent 实现,local 无);SSE 连接时触发 */
  resume?(sessionId: string, signal: AbortSignal): Promise<void>;
  // 预留:per-target 模型切换(内嵌 eveagent 改文件重启场景),当前不实现,场景来时加
  // switchModel?(targetId: string, model: string): Promise<void>;
}

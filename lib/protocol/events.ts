// webtool 消息协议事件 —— UIMessage.parts 的流式增量传输(见 03-protocol-contract.md)
//
// partId 是 part 级标识(≠ step,见 06-backend-id-system.md):
//   tool part 复用后端稳定 id(eve callId / pi toolCallId / claude tool_use.id);
//   text/reasoning part 由 adapter 合成(eve `${turnId}:${stepIndex}:type` / claude `${message.id}#${index}`)。
// persist 落库时给每个 part 注入 `_pid: partId`,供 part.delta/update 在 parts JSON 里定位(无状态)。
import type { UIMessagePart } from 'ai';

// 消息级元数据(03 契约③):起步四字段,可扩展对齐 open-agents WebAgentMessageMetadata
export interface WebtoolMessageMetadata {
  modelId?: string;
  usage?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number };
  cost?: number;
  finishReason?: 'stop' | 'interrupted' | 'error' | 'length' | 'tool-calls' | string;
  optimistic?: boolean;  // T-013:乐观 user 消息标记(send 插入,assistant part.start 清除)
}

// 落库 part 类型:UIMessagePart + 私有 _pid(persist 注入,ai-elements 渲染忽略未知字段)
export type PersistedPart = UIMessagePart<any, any> & { _pid?: string };

// HITL 回答(eve input.requested 的回应):optionId 选选项 / text 自由文本(二者二选一)
// 对齐 eve runtime/input/types.ts 的 inputResponseSchema:requestId 必填,optionId/text 至少一个
export type InputResponse = {
  requestId: string;
  optionId?: string;
  text?: string;
};

// UIMessage.parts 的流式增量。前端/persist 累积成 UIMessage,喂 ai-elements 渲染。
export type WebtoolEvent =
  // 新增 part(挂到当前 assistant 消息 parts 末尾);part 为初始态
  | { type: 'part.start'; partId: string; part: UIMessagePart<any, any> }
  // 追加增量到 part 字段:text.text / reasoning.text / tool.input 的 JSON 片段
  | { type: 'part.delta'; partId: string; field: 'text' | 'reasoning' | 'input'; delta: string }
  // 替换/更新 part 字段(state 变化、output、errorText、approval、preliminary partialResult)
  | { type: 'part.update'; partId: string; patch: Record<string, unknown> }
  // part 结束(可选最终完整快照,落库 + 前端校正)
  | { type: 'part.end'; partId: string; part?: UIMessagePart<any, any> }
  // 消息级元数据(modelId/usage/cost/finishReason)
  | { type: 'message.metadata'; metadata: Partial<WebtoolMessageMetadata> }
  // turn 边界
  | { type: 'turn.completed'; finishReason: 'stop' | 'interrupted' | 'error'; error?: { code: string; message: string } }
  // 会话级(保留)
  | { type: 'session.connected' }
  | { type: 'session.disconnected'; reason: 'device_offline' | 'network' | 'restart' }
  // history 暂为 {role,content}(降级点 #2,见 05-schema-design.md):adapter 改造阶段改为传完整 parts 由各后端转换
  | { type: 'session.start'; sessionId: string; backend: string; model: string; history: Array<{ role: string; content: string }> };

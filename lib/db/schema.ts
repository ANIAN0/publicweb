import { sqliteTable, text, integer, primaryKey, unique } from 'drizzle-orm/sqlite-core';

export const devices = sqliteTable('devices', {
  id: text('id').primaryKey(),                                  // ulid
  name: text('name').notNull(),
  hostname: text('hostname'),                                  // 本地 client 上报
  longLivedTokenHash: text('long_lived_token_hash').notNull(),
  lastSeenAt: integer('last_seen_at', { mode: 'timestamp' }),
  online: integer('online', { mode: 'boolean' }).default(false),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const deviceSupportedBackends = sqliteTable('device_supported_backends', {
  deviceId: text('device_id').notNull().references(() => devices.id),
  backend: text('backend').notNull(),                          // 'claudecode' | 'pi'
}, t => ({ pk: primaryKey({ columns: [t.deviceId, t.backend] }) }));

export const deviceModels = sqliteTable('device_models', {
  deviceId: text('device_id').notNull().references(() => devices.id),
  backend: text('backend').notNull(),
  modelsJson: text('models_json').notNull(),                   // JSON: [{id, label, default?}]
  refreshedAt: integer('refreshed_at', { mode: 'timestamp' }).notNull(),
}, t => ({ pk: primaryKey({ columns: [t.deviceId, t.backend] }) }));

export const setupTokens = sqliteTable('setup_tokens', {
  id: text('id').primaryKey(),
  tokenHash: text('token_hash').notNull(),                      // 一次性 token 的 SHA256
  deviceName: text('device_name').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  usedAt: integer('used_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),                                 // ulid
  backend: text('backend').notNull(),                           // 'eveagent' | 'claudecode' | 'pi'
  deviceId: text('device_id').references(() => devices.id),     // null for eveagent
  model: text('model').notNull(),
  title: text('title'),                                        // 自动标题（首条用户消息前 30 字）
  userTitle: text('user_title'),                                // 用户自定义，覆盖 title
  eveSessionId: text('eve_session_id'),                        // eveagent 专用
  eveContinuationToken: text('eve_continuation_token'),        // eveagent 专用
  localSessionRef: text('local_session_ref'),                  // 本地 client 内部 ID
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  lastActiveAt: integer('last_active_at', { mode: 'timestamp' }).notNull(),
  deletedAt: integer('deleted_at', { mode: 'timestamp' }),
});

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),                                 // ulid
  sessionId: text('session_id').notNull().references(() => sessions.id),
  seq: integer('seq').notNull(),                               // 单 session 内顺序
  role: text('role').notNull(),                                // 'user' | 'assistant' | 'tool' | 'system'
  content: text('content').notNull().default(''),              // 文本片段 / 序列化 JSON
  toolCalls: text('tool_calls'),                               // JSON: [{id, name, input}]
  toolResults: text('tool_results'),                           // JSON: [{toolCallId, output, isError}]
  reasoning: text('reasoning'),                                // 思考过程（REV-005-15：eveagent reasoning.delta 落库）
  finishReason: text('finish_reason'),                         // 'stop' | 'interrupted' | 'error'
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, t => ({
  // REV-005-14：单 session 内 seq 必须唯一，防止 select max(seq)+1 竞态产生重复 seq，
  // 破坏 orderBy(seq) 与增量拉取语义。
  sessionSeqUnique: unique('messages_session_seq_unique').on(t.sessionId, t.seq),
}));
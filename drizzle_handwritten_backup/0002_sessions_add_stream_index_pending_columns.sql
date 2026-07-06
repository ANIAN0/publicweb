-- sessions 表新增 streamIndex/pendingUserMessage/pendingUserMessageCreatedAt 列
-- 用于 eve stream resume 游标和 pending user message 跟踪
ALTER TABLE `sessions` ADD COLUMN `stream_index` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `sessions` ADD COLUMN `pending_user_message` text;
--> statement-breakpoint
ALTER TABLE `sessions` ADD COLUMN `pending_user_message_created_at` integer;
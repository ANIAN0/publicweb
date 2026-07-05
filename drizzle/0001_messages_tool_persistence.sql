-- 修复 REV-005-14 + REV-005-15：messages 表加 reasoning 列与 (session_id, seq) 唯一索引
ALTER TABLE `messages` ADD COLUMN `reasoning` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_session_seq_unique` ON `messages`(`session_id`, `seq`);

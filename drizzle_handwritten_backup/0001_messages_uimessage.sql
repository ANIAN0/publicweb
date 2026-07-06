-- messages 表对齐 UIMessage:5 扁平列(content/reasoning/toolCalls/toolResults/finishReason)→ parts+metadata 两 JSON 列
-- 见 workplace/chat-protocol/05-schema-design.md
-- 旧数据清空(用户决策 2026-07-05):drop + recreate;旧 4 列扁平结构永久丢失 part 顺序,无法忠实还原,任何转换都是降级
DROP TABLE IF EXISTS `messages`;
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL REFERENCES `sessions`(`id`),
	`seq` integer NOT NULL,
	`role` text NOT NULL,
	`parts` text NOT NULL,
	`metadata` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_session_seq_unique` ON `messages` (`session_id`,`seq`);

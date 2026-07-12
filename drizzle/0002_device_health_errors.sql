-- 设备心跳快照 + 客户端错误落库（第一梯队：健康上报 / 错误分类）
ALTER TABLE `devices` ADD `health_json` text;--> statement-breakpoint
CREATE TABLE `device_errors` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`code` text NOT NULL,
	`message` text NOT NULL,
	`category` text,
	`session_id` text,
	`stack` text,
	`context_json` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `device_models` (
	`device_id` text NOT NULL,
	`backend` text NOT NULL,
	`models_json` text NOT NULL,
	`refreshed_at` integer NOT NULL,
	PRIMARY KEY(`device_id`, `backend`),
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `device_supported_backends` (
	`device_id` text NOT NULL,
	`backend` text NOT NULL,
	PRIMARY KEY(`device_id`, `backend`),
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`hostname` text,
	`long_lived_token_hash` text NOT NULL,
	`last_seen_at` integer,
	`online` integer DEFAULT false,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `eve_services` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`host` text NOT NULL,
	`model` text NOT NULL,
	`auth_type` text DEFAULT 'none' NOT NULL,
	`auth_config` text,
	`online` integer DEFAULT false,
	`last_seen_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`seq` integer NOT NULL,
	`role` text NOT NULL,
	`parts` text NOT NULL,
	`metadata` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_session_seq_unique` ON `messages` (`session_id`,`seq`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`backend` text NOT NULL,
	`target_id` text NOT NULL,
	`model` text NOT NULL,
	`title` text,
	`user_title` text,
	`eve_session_id` text,
	`eve_continuation_token` text,
	`local_session_ref` text,
	`stream_index` integer DEFAULT 0 NOT NULL,
	`pending_user_message` text,
	`pending_user_message_created_at` integer,
	`created_at` integer NOT NULL,
	`last_active_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE TABLE `setup_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`device_name` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL
);

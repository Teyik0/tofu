CREATE TABLE IF NOT EXISTS `anilist` (
	`id` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `judgements` (
	`createdAt` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `plugins` (
	`id` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `preferences` (
	`id` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `releases` (
	`id` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `automations` (
	`id` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `config` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `destinations` (
	`downloadPath` text NOT NULL,
	`icon` text DEFAULT 'folder' NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`pinned` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `torrents` (
	`id` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);

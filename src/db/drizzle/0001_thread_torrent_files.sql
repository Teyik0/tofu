CREATE TABLE `watched_files` (
	`changedAt` integer NOT NULL,
	`infoHash` text,
	`path` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
ALTER TABLE `destinations` ADD `autoAddTorrentFilesSince` integer;--> statement-breakpoint
ALTER TABLE `destinations` ADD `deleteTorrentFileAfterAdd` integer;
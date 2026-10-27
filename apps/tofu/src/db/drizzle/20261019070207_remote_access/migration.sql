CREATE TABLE `devices` (
	`canDeleteFiles` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`grantVersion` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`invitationId` text,
	`issuer` text NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`lastSeenAt` integer NOT NULL,
	`pairedAt` integer NOT NULL,
	`profileId` text NOT NULL,
	`redemptionNonceHash` text,
	`revokedAt` integer,
	`role` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `connection_state` (
	`key` text PRIMARY KEY NOT NULL,
	`updatedAt` integer NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `device_sessions` (
	`createdAt` integer NOT NULL,
	`deviceId` text NOT NULL,
	`expiresAt` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`idleExpiresAt` integer NOT NULL,
	`kind` text NOT NULL,
	`lastSeenAt` integer NOT NULL,
	`tokenHash` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_sessions_tokenHash_unique` ON `device_sessions` (`tokenHash`);--> statement-breakpoint
CREATE TABLE `linked_servers` (
	`createdAt` integer NOT NULL,
	`credential` text NOT NULL,
	`deviceId` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`lastCheckedAt` integer,
	`name` text NOT NULL,
	`origin` text NOT NULL,
	`serverId` text NOT NULL,
	`state` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `linked_servers_serverId_unique` ON `linked_servers` (`serverId`);--> statement-breakpoint
CREATE TABLE `media_links` (
	`createdAt` integer NOT NULL,
	`deviceId` text,
	`expiresAt` integer NOT NULL,
	`fileIndex` integer NOT NULL,
	`fileLength` integer NOT NULL,
	`fileName` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`revokedAt` integer,
	`tokenHash` text NOT NULL,
	`torrentId` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_links_tokenHash_unique` ON `media_links` (`tokenHash`);--> statement-breakpoint
CREATE TABLE `operation_receipts` (
	`completedAt` integer,
	`createdAt` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`result` text,
	`status` text NOT NULL,
	`target` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `invitations` (
	`canDeleteFiles` integer NOT NULL,
	`codeHash` text NOT NULL,
	`consumedAt` integer,
	`consumedBy` text,
	`createdAt` integer NOT NULL,
	`expiresAt` integer NOT NULL,
	`failedAttempts` integer DEFAULT 0 NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`issuer` text NOT NULL,
	`label` text NOT NULL,
	`profileId` text,
	`revokedAt` integer,
	`role` text NOT NULL,
	`secretHash` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invitations_codeHash_unique` ON `invitations` (`codeHash`);--> statement-breakpoint
CREATE UNIQUE INDEX `invitations_secretHash_unique` ON `invitations` (`secretHash`);--> statement-breakpoint
CREATE TABLE `playback_positions` (
	`duration` real NOT NULL,
	`mediaKey` text NOT NULL,
	`position` real NOT NULL,
	`profileId` text NOT NULL,
	`sequence` integer NOT NULL,
	`sessionId` text NOT NULL,
	`updatedAt` integer NOT NULL,
	PRIMARY KEY(`profileId`, `mediaKey`)
);
--> statement-breakpoint
CREATE TABLE `server_identity` (
	`createdAt` integer NOT NULL,
	`identityEpoch` integer NOT NULL,
	`key` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`serverId` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `storage_roots` (
	`createdAt` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`path` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `storage_roots_path_unique` ON `storage_roots` (`path`);
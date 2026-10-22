CREATE TABLE `session_transfers` (
	`tokenHash` text PRIMARY KEY NOT NULL,
	`sourceSessionId` text NOT NULL,
	`origin` text NOT NULL,
	`grantVersion` integer NOT NULL,
	`expiresAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_transfers_sourceSessionId_unique` ON `session_transfers` (`sourceSessionId`);
CREATE TABLE `playback_sequences` (
	`profileId` text NOT NULL,
	`mediaKey` text NOT NULL,
	`sessionId` text NOT NULL,
	`sequence` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	PRIMARY KEY(`profileId`, `mediaKey`, `sessionId`)
);

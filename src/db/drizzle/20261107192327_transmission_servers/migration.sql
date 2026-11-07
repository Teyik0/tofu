CREATE TABLE `transmission_servers` (
	`createdAt` integer NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`origin` text NOT NULL,
	`password` text,
	`rpcPath` text DEFAULT '/transmission/rpc' NOT NULL,
	`updatedAt` integer NOT NULL,
	`username` text
);

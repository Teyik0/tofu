DROP TABLE `judgements`;--> statement-breakpoint
DELETE FROM `plugins` WHERE `id` = 'jev';--> statement-breakpoint
UPDATE `automations`
SET `value` = json_set(`value`, '$.matchMode', 'exact')
WHERE json_extract(`value`, '$.matchMode') = 'jev';--> statement-breakpoint
UPDATE `anilist`
SET `value` = json_set(`value`, '$.template.matchMode', 'exact')
WHERE json_extract(`value`, '$.template.matchMode') = 'jev';

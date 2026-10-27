import { integer, maxLength, minValue, number, object, pipe, string } from "valibot";

export const mediaLinkSchema = object({
  fileIndex: pipe(number(), integer(), minValue(0)),
  torrentId: pipe(string(), maxLength(64)),
});

export const mediaLinkRevokeSchema = object({ id: pipe(string(), maxLength(64)) });

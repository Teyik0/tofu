export async function readLogRecords(path: string) {
  const text = await Bun.file(path).text();
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

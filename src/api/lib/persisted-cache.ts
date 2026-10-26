// Retain unchanged objects: background tasks use their identities to detect replacement or removal.
export function refreshRecords<Value>(
  cache: Map<string, Value>,
  rows: { id: string; value: string }[],
  decode: (value: string) => Value
) {
  const retained = new Set<string>();
  for (const row of rows) {
    retained.add(row.id);
    if (JSON.stringify(cache.get(row.id)) !== row.value) {
      cache.set(row.id, decode(row.value));
    }
  }
  for (const id of cache.keys()) {
    if (!retained.has(id)) {
      cache.delete(id);
    }
  }
}

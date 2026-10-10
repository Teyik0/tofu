// Retain unchanged objects: background tasks use their identities to detect replacement or removal.
export function refreshRecords<Value>(
  cache: Map<string, Value>,
  rows: { id: string; value: string }[]
) {
  const retained = new Set<string>();
  for (const row of rows) {
    retained.add(row.id);
    if (JSON.stringify(cache.get(row.id)) !== row.value) {
      cache.set(row.id, JSON.parse(row.value) as Value);
    }
  }
  for (const id of cache.keys()) {
    if (!retained.has(id)) {
      cache.delete(id);
    }
  }
}

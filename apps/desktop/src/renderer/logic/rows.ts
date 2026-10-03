/**
 * which row is active after a list changed. tracked by id, so live inserts never move it, and a
 * row that leaves hands the keyboard to whatever took its index. a new query starts from the first
 * row it found - the top, unless the list says otherwise.
 */
export function nextActiveKey(
  prevKeys: readonly string[],
  nextKeys: readonly string[],
  active: string | null,
  queryChanged: boolean,
  firstMatch?: string,
): string | null {
  if (nextKeys.length === 0) return null;
  if (queryChanged || active === null) {
    return firstMatch && nextKeys.includes(firstMatch) ? firstMatch : (nextKeys[0] ?? null);
  }
  if (nextKeys.includes(active)) return active;
  const was = prevKeys.indexOf(active);
  return nextKeys[Math.min(Math.max(was, 0), nextKeys.length - 1)] ?? null;
}

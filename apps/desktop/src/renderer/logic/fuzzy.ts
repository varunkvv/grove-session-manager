// what `/` and `@` match by: the letters typed, in order, anywhere in the name. a run of them, the
// start of a word, and the name's last part count for more. pure.

const BOUNDARY = /[/\-_. ]/;

/** how well `query` matches `text`: higher is better, null when it does not */
export function fuzzy(query: string, text: string): number | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return -t.length / 1000;
  let score = 0;
  let from = 0;
  let run = 0;
  for (const ch of q) {
    const at = t.indexOf(ch, from);
    if (at < 0) return null;
    run = at === from && from > 0 ? run + 1 : 0;
    score += 1 + run * 2 + (at === 0 || BOUNDARY.test(t.charAt(at - 1)) ? 3 : 0);
    from = at + 1;
  }
  // typed whole: in the name's last part (a file's name) more than anywhere in it
  const whole = t.lastIndexOf(q);
  if (whole >= 0) score += whole > t.lastIndexOf("/") ? 8 : 4;
  // the shorter of two equal matches
  return score - t.length / 1000;
}

/** the best `max` of `items` for `query`, best first */
export function rank<T>(
  items: readonly T[],
  query: string,
  textOf: (t: T) => string,
  max = 50,
): T[] {
  const scored: Array<[number, T]> = [];
  for (const item of items) {
    const s = fuzzy(query, textOf(item));
    if (s !== null) scored.push([s, item]);
  }
  return scored
    .sort((a, b) => b[0] - a[0])
    .slice(0, max)
    .map(([, item]) => item);
}

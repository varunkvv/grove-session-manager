// what token counts would cost on the API, at list price. no node: imports.
import type { ModelCounts } from "./usage.ts";

/** USD per million tokens */
export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

/** a cache write is 1.25x the input price when kept 5 minutes and 2x when kept an hour */
const price = (input: number, output: number, cacheRead = input / 10): Price => ({
  input,
  output,
  cacheRead,
  cacheWrite5m: input * 1.25,
  cacheWrite1h: input * 2,
});

/**
 * list prices, from Anthropic's pricing as of 2026-10-06. a cache read is a tenth of the input
 * price unless the model says otherwise.
 *
 * the 1M context window is at the standard price on all of these, so `[1m]` is not a tier. fast
 * mode is: 2x on opus 5 and 5.5. no transcript on the machine this was built on has a fast
 * response (`usage.speed`), so it is not counted apart
 */
// ponytail: haiku 5.5 is 5x past a 100K prompt, and is priced here as under it. that tier is per
// response, so it would be a key of its own in the scan. $0.003 of haiku 5.5 when this was written
const PRICES: Record<string, Price> = {
  "claude-fable-5-1": price(10, 50, 0.25),
  "claude-fable-5": price(10, 50),
  "claude-opus-5-5": price(4, 20, 0.2),
  "claude-opus-5": price(5, 25),
  "claude-opus-4-8": price(5, 25),
  "claude-opus-4-7": price(5, 25),
  "claude-opus-4-6": price(5, 25),
  "claude-sonnet-5-5": price(2, 10),
  "claude-sonnet-5": price(2, 10),
  "claude-sonnet-4-6": price(3, 15),
  "claude-haiku-5-5": price(0.1, 0.5),
  "claude-haiku-4-5": price(1, 5),
};

/** the newest of each family: what a model the table has never heard of is priced as */
const FAMILY: Record<string, string> = {
  fable: "claude-fable-5-1",
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-5-5",
};

/**
 * the price of a model, or null when it has none. `claude-opus-5[1m]` and
 * `claude-haiku-4-5-20251001` are their base model. an unknown model of a known family gets that
 * family's newest price. anything else is unpriced: its tokens count, its cost is left out
 */
export function priceOf(model: string): Price | null {
  const base = model.replace(/\[[^\]]*\]$/, "").replace(/-\d{8}$/, "");
  const known = PRICES[base];
  if (known) return known;
  const family = /opus|sonnet|haiku|fable/.exec(base)?.[0];
  return (family && PRICES[FAMILY[family] ?? ""]) || null;
}

/** USD, or null for a model with no price */
export function costOf(
  model: string,
  c: Pick<ModelCounts, "input" | "output" | "cacheRead" | "cacheWrite" | "cacheWrite1h">,
): number | null {
  const p = priceOf(model);
  if (!p) return null;
  return (
    (c.input * p.input +
      c.output * p.output +
      c.cacheRead * p.cacheRead +
      (c.cacheWrite - c.cacheWrite1h) * p.cacheWrite5m +
      c.cacheWrite1h * p.cacheWrite1h) /
    1_000_000
  );
}

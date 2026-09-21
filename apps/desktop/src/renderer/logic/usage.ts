import { formatTokens, type ModelUsage, modelLabel, tokenTotal } from "@grove/core/pure";

/** the row shows the two biggest models. the rest are a count, and the tooltip has them all. */
export function usageChip(usage: readonly ModelUsage[]): string {
  const shown = usage
    .slice(0, 2)
    .map((u) => `${modelLabel(u.model)} ${formatTokens(tokenTotal(u))}`);
  const more = usage.length - shown.length;
  return more > 0 ? `${shown.join(" · ")} +${more}` : shown.join(" · ");
}

export function usageTooltip(usage: readonly ModelUsage[]): string {
  return usage
    .map(
      (u) =>
        `${modelLabel(u.model)}: ${formatTokens(tokenTotal(u))} tokens - ` +
        `${formatTokens(u.input)} in, ${formatTokens(u.output)} out, ` +
        `${formatTokens(u.cacheRead)} cache read, ${formatTokens(u.cacheWrite)} cache write`,
    )
    .join("\n");
}

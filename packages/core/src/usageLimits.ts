// the account's own usage limits, as Claude Code last fetched them: `cachedUsageUtilization` in
// its state file (`~/.claude.json`), the same numbers its /usage shows. pure: main reads the file,
// the Usage screen and the menu bar draw what this makes of it.
//
// nothing documents the shape. a metered (usage-based) account was seen: `spend` and
// `extra_usage`, every window null. a plan's windows (`five_hour`, `seven_day`, ...) are as Claude
// Code's own schema has them and were never seen in a real file. so every field is optional,
// unknown keys are ignored, and a field of the wrong type counts as absent.
import { formatRelativeTime } from "./time.ts";

/** how close to its limit, as the account says or, when it says nothing this knows, by the number */
export type LimitSeverity = "normal" | "warning" | "critical";

/** money against a cap, in the currency's units: 410.31 of 2000 */
export interface LimitSpend {
  used: number;
  /** null: no cap */
  limit: number | null;
  /** ISO 4217, `USD` */
  currency: string;
  /** digits after the point: 2 for cents */
  digits: number;
  /** of the cap, 0 to 100. null with no cap */
  percent: number | null;
  severity: LimitSeverity;
}

/** one of a plan's rolling windows: how much of it is used and when it starts over */
export interface LimitWindow {
  /** the file's own key: `five_hour`, `seven_day`, ... */
  key: string;
  /** `5-hour limit`, `Weekly limit`, `Weekly Opus limit` */
  label: string;
  /** 0 to 100 */
  percent: number;
  /** epoch ms. null when the file says none */
  resetsAt: number | null;
  severity: LimitSeverity;
}

export interface UsageLimits {
  /** metered: billed for what is used, up to a cap. plan: a subscription's windows */
  kind: "metered" | "plan";
  /** when Claude Code fetched it, epoch ms */
  fetchedAt: number;
  spend?: LimitSpend;
  /** the windows that have a number: the named ones shortest first, then `limits[]`'s. none on a metered account */
  windows: LimitWindow[];
}

/** what the Usage screen shows: Grove's pricing of the transcripts, or the account's own numbers */
export type UsageMode = "api-equivalent" | "actual";

const WINDOWS: ReadonlyArray<readonly [string, string]> = [
  ["five_hour", "5-hour limit"],
  ["seven_day", "Weekly limit"],
  ["seven_day_opus", "Weekly Opus limit"],
  ["seven_day_sonnet", "Weekly Sonnet limit"],
];

/** past this a limit with no word from the account is close */
const WARN_AT = 80;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : undefined;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;
/** digits after the point, 0 to 6. anything else is cents */
const digitsOf = (v: unknown): number => {
  const n = num(v);
  return n !== null && Number.isInteger(n) && n >= 0 && n <= 6 ? n : 2;
};

function severityOf(said: unknown, percent: number | null, reached: boolean): LimitSeverity {
  if (reached || (percent !== null && percent >= 100)) return "critical";
  const word = typeof said === "string" ? said.toLowerCase() : "";
  if (/crit|exceed|reached|block|error/.test(word)) return "critical";
  if (/warn|approach|high/.test(word)) return "warning";
  // only `normal` was ever seen. a word this does not know, or none, goes by the number
  if (word === "normal" || word === "ok") return "normal";
  return percent !== null && percent >= WARN_AT ? "warning" : "normal";
}

/** `{amount_minor, currency, exponent}` */
function moneyOf(v: unknown): { amount: number; currency?: string; digits: number } | null {
  const m = obj(v);
  const minor = num(m?.amount_minor);
  if (!m || minor === null) return null;
  const digits = digitsOf(m.exponent);
  return { amount: minor / 10 ** digits, currency: str(m.currency), digits };
}

/**
 * `spend` when it is there and on, else the older `extra_usage`, and which one it was: a plan's
 * extra usage is an `extra_usage` too
 */
function spendOf(u: Obj): { spend: LimitSpend; from: "spend" | "extra_usage" } | undefined {
  const extra = obj(u.extra_usage);
  const reached = extra?.spend_limit_reached === true;
  const s = obj(u.spend);
  const used = s && s.enabled !== false ? moneyOf(s.used) : null;
  if (s && used) {
    const cap = moneyOf(s.limit);
    const percent = cap
      ? (num(s.percent) ?? (cap.amount > 0 ? (used.amount / cap.amount) * 100 : null))
      : null;
    return {
      from: "spend",
      spend: {
        used: used.amount,
        limit: cap?.amount ?? null,
        currency: used.currency ?? cap?.currency ?? "USD",
        digits: used.digits,
        percent,
        severity: severityOf(s.severity, percent, reached),
      },
    };
  }
  if (extra?.is_enabled !== true) return undefined;
  const digits = digitsOf(extra.decimal_places);
  const usedMinor = num(extra.used_credits) ?? 0;
  const capMinor = num(extra.monthly_limit);
  const percent =
    capMinor === null
      ? null
      : (num(extra.utilization) ?? (capMinor > 0 ? (usedMinor / capMinor) * 100 : null));
  return {
    from: "extra_usage",
    spend: {
      used: usedMinor / 10 ** digits,
      limit: capMinor === null ? null : capMinor / 10 ** digits,
      currency: str(extra.currency) ?? "USD",
      digits,
      percent,
      severity: severityOf(undefined, percent, reached),
    },
  };
}

const timeOf = (v: unknown): number | null => {
  const at = typeof v === "string" ? Date.parse(v) : Number.NaN;
  return Number.isFinite(at) ? at : null;
};

/** `five_hour` is a 5-hour window, `seven_day` or `weekly` a week's. "" when the word says neither */
const periodOf = (kind: string): string =>
  /five|5h|session/i.test(kind) ? "5-hour" : /seven|week/i.test(kind) ? "weekly" : "";

/** the model family a name is of, for telling a duplicate apart: `Opus 5.5` is opus */
const familyOf = (name: string): string =>
  /opus|sonnet|haiku|fable/i.exec(name)?.[0].toLowerCase() ?? name.toLowerCase();

/** what a named window covers, to drop a `limits[]` entry that says the same */
const COVERS: Record<string, { period: string; family: string }> = {
  five_hour: { period: "5-hour", family: "" },
  seven_day: { period: "weekly", family: "" },
  seven_day_opus: { period: "weekly", family: "opus" },
  seven_day_sonnet: { period: "weekly", family: "sonnet" },
};

/**
 * the named windows, shortest first, then the `limits[]` entries with a number that none of them
 * already says, in the file's order. an entry is named by its period and its model (or surface)
 */
function windowsOf(u: Obj): LimitWindow[] {
  const named: LimitWindow[] = WINDOWS.flatMap(([key, label]) => {
    const w = obj(u[key]);
    const percent = num(w?.utilization);
    if (!w || percent === null) return [];
    return [
      {
        key,
        label,
        percent,
        resetsAt: timeOf(w.resets_at),
        severity: severityOf(undefined, percent, false),
      },
    ];
  });
  const covered = named.map((w) => COVERS[w.key]).filter((c) => c !== undefined);
  const listed = (Array.isArray(u.limits) ? u.limits : []).flatMap((raw, i): LimitWindow[] => {
    const e = obj(raw);
    const percent = num(e?.percent);
    if (!e || percent === null) return [];
    const scope = obj(e.scope);
    const name = str(obj(scope?.model)?.display_name) ?? str(obj(scope?.surface)?.display_name);
    const kind = str(e.kind) ?? "";
    const period = periodOf(kind);
    const family = name ? familyOf(name) : "";
    // one with no period of its own is a duplicate only of a model's window, never of the 5-hour one
    const same = (c: { period: string; family: string }) =>
      c.family === family && (c.period === period || (!period && c.family !== ""));
    if (covered.some(same)) return [];
    const words = [period, name].filter(Boolean).join(" ");
    return [
      {
        key: `limits-${i}`,
        label: words ? `${words.charAt(0).toUpperCase()}${words.slice(1)} limit` : "Usage limit",
        percent,
        resetsAt: timeOf(e.resets_at),
        severity: severityOf(e.severity, percent, false),
      },
    ];
  });
  return [...named, ...listed];
}

/**
 * the limits in Claude Code's state file, given the file parsed whole. null when there is nothing
 * to show: no cache, a cache of another account than the one signed in (Claude Code drops those
 * itself), or neither windows nor a spend
 */
export function parseUsageUtilization(config: unknown): UsageLimits | null {
  const file = obj(config);
  const cache = obj(file?.cachedUsageUtilization);
  const u = obj(cache?.utilization);
  const fetchedAt = num(cache?.fetchedAtMs);
  if (!cache || !u || fetchedAt === null) return null;
  const account = obj(file?.oauthAccount);
  const signedIn = str(account?.accountUuid);
  const cachedFor = str(cache.accountUuid);
  if (signedIn && cachedFor && signedIn !== cachedFor) return null;

  const windows = windowsOf(u);
  const found = spendOf(u);
  const spend = found?.spend;
  // the account says it is billed by use
  const usageBased = /usage_based/.test(`${account?.seatTier ?? ""} ${account?.billingType ?? ""}`);
  // windows are a plan's. so is an `extra_usage` alone, with no word that the account is billed by
  // use: it is what a plan spends past its limits
  const kind =
    windows.length > 0 && !(spend && usageBased)
      ? "plan"
      : found
        ? usageBased || found.from === "spend"
          ? "metered"
          : "plan"
        : null;
  if (!kind) return null;
  return { kind, fetchedAt, ...(spend ? { spend } : {}), windows };
}

/** with no choice saved: the account's own numbers when it is billed by use, the transcripts' else */
export function usageModeOf(saved: UsageMode | undefined, limits: UsageLimits | null): UsageMode {
  return saved ?? (limits?.kind === "metered" ? "actual" : "api-equivalent");
}

/** past this the menu bar's title leaves the number out: its menu and tooltip still say it, and how old */
export const LIMIT_STALE_MS = 24 * 60 * 60_000;

/** the one number the menu bar shows */
export interface LimitHeadline {
  /** 0 to 100 */
  percent: number;
  /** `$2,000 limit`, `5-hour limit` */
  label: string;
  /** a plan window's next start, epoch ms */
  resetsAt: number | null;
  fetchedAt: number;
  /** fetched longer than `maxAgeMs` ago */
  stale: boolean;
}

/**
 * a metered account's spend against its cap, or the plan window nearest its limit: the one that
 * stops you first. a window that has started over since the fetch is left out, its number is old.
 * null with nothing that has a limit
 */
export function headlineLimit(
  limits: UsageLimits | null,
  now: number,
  maxAgeMs: number = LIMIT_STALE_MS,
): LimitHeadline | null {
  if (!limits) return null;
  const { fetchedAt } = limits;
  const stale = now - fetchedAt > maxAgeMs;
  if (limits.kind === "plan") {
    const open = limits.windows.filter((w) => w.resetsAt === null || w.resetsAt > now);
    const top = open.reduce<LimitWindow | null>(
      (best, w) => (!best || w.percent > best.percent ? w : best),
      null,
    );
    return top
      ? { percent: top.percent, label: top.label, resetsAt: top.resetsAt, fetchedAt, stale }
      : null;
  }
  const s = limits.spend;
  if (!s || s.limit === null || s.percent === null) return null;
  return {
    percent: s.percent,
    label: `${formatMoney(s.limit, s.currency, s.digits)} limit`,
    resetsAt: null,
    fetchedAt,
    stale,
  };
}

/** `$410.31`, and a whole amount without cents: `$2,000` */
export function formatMoney(amount: number, currency: string, digits = 2): string {
  const shown = Number.isInteger(amount) ? 0 : digits;
  try {
    return amount.toLocaleString("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: shown,
      maximumFractionDigits: shown,
    });
  } catch {
    // not a currency code Intl knows
    return `${amount.toFixed(shown)} ${currency}`;
  }
}

/** how long until a window starts over: `42m`, `2h 10m`, `3d 4h`. under a minute is `<1m` */
export function formatSpan(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

/** `resets in 2h 10m`, or `reset 1h ago` for one that already has */
export function resetWords(resetsAt: number, now: number): string {
  return resetsAt > now
    ? `resets in ${formatSpan(resetsAt - now)}`
    : `reset ${formatRelativeTime(resetsAt, now)}`;
}

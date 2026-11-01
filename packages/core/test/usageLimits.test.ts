import { describe, expect, it } from "vitest";
import {
  formatMoney,
  formatSpan,
  headlineLimit,
  parseUsageUtilization,
  resetWords,
  type UsageLimits,
  usageModeOf,
} from "../src/usageLimits.ts";

const ACCOUNT = "00000000-0000-4000-8000-00000000000a";
const FETCHED = 1_793_462_991_265;
const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = FETCHED + 8 * HOUR;

/**
 * the shape a metered (enterprise, usage-based) account had in `~/.claude.json` on 2026-11-01,
 * ids and names taken out. every window is null, and there are keys nobody documents
 */
const metered = () => ({
  numStartups: 412,
  oauthAccount: {
    accountUuid: ACCOUNT,
    billingType: "stripe_subscription_contracted",
    seatTier: "enterprise_usage_based",
    organizationType: "claude_enterprise",
    hasExtraUsageEnabled: true,
  },
  cachedUsageUtilization: {
    fetchedAtMs: FETCHED,
    accountUuid: ACCOUNT,
    utilization: {
      five_hour: null,
      seven_day: null,
      seven_day_oauth_apps: null,
      seven_day_opus: null,
      seven_day_sonnet: null,
      seven_day_cowork: null,
      tangelo: null,
      iguana_necktie: null,
      promo_credits: null,
      pace: null,
      extra_usage: {
        is_enabled: true,
        monthly_limit: 200000,
        used_credits: 41031,
        utilization: 20.5155,
        currency: "USD",
        decimal_places: 2,
        disabled_reason: null,
        user_disabled: false,
        spend_limit_reached: false,
        credits_ever_enabled: true,
        daily: null,
        weekly: null,
      },
      limits: [],
      spend: {
        used: { amount_minor: 41031, currency: "USD", exponent: 2 },
        limit: { amount_minor: 200000, currency: "USD", exponent: 2 },
        percent: 21,
        severity: "normal",
        enabled: true,
        disabled_reason: null,
        cap: { money: null, credits: { amount_minor: 200000, exponent: 2 } },
        balance: null,
        auto_reload: null,
        disclaimer: "Usage credits cover you when you hit your plan limits.",
        can_purchase_credits: false,
        can_toggle: false,
      },
      member_dashboard_available: true,
      seven_day_breakdown: null,
      weekly_scoped_shares: null,
    },
  },
});

/** a plan account as Claude Code's schema and third-party clients describe it. never seen for real */
const plan = (windows: Record<string, unknown> = {}) => ({
  oauthAccount: { accountUuid: ACCOUNT, billingType: "stripe_subscription" },
  cachedUsageUtilization: {
    fetchedAtMs: FETCHED,
    accountUuid: ACCOUNT,
    utilization: {
      five_hour: { utilization: 42, resets_at: new Date(FETCHED + 10 * HOUR).toISOString() },
      seven_day: { utilization: 63.5, resets_at: new Date(FETCHED + 3 * 24 * HOUR).toISOString() },
      seven_day_opus: null,
      seven_day_sonnet: { utilization: 7, resets_at: null },
      something_new: { utilization: 99, resets_at: "2026-11-02T00:00:00Z" },
      extra_usage: {
        is_enabled: false,
        monthly_limit: null,
        used_credits: null,
        utilization: null,
      },
      ...windows,
    },
  },
});

/** one field of the metered cache changed */
const meteredWith = (u: Record<string, unknown>) => {
  const m = metered();
  Object.assign(m.cachedUsageUtilization.utilization, u);
  return m;
};

describe("parseUsageUtilization", () => {
  it("reads a metered account's spend against its cap", () => {
    expect(parseUsageUtilization(metered())).toEqual({
      kind: "metered",
      fetchedAt: FETCHED,
      spend: {
        used: 410.31,
        limit: 2000,
        currency: "USD",
        digits: 2,
        percent: 21,
        severity: "normal",
      },
      windows: [],
    } satisfies UsageLimits);
  });

  it("falls back to extra_usage when there is no spend", () => {
    const m = meteredWith({ spend: undefined });
    expect(parseUsageUtilization(m)?.spend).toEqual({
      used: 410.31,
      limit: 2000,
      currency: "USD",
      digits: 2,
      percent: 20.5155,
      severity: "normal",
    });
    // a spend that is switched off is not one either
    expect(
      parseUsageUtilization(
        meteredWith({
          spend: { ...metered().cachedUsageUtilization.utilization.spend, enabled: false },
        }),
      )?.spend?.percent,
    ).toBe(20.5155);
  });

  it("works the percent out when the file does not say it", () => {
    const spend = metered().cachedUsageUtilization.utilization.spend;
    const m = meteredWith({ spend: { ...spend, percent: undefined } });
    expect(parseUsageUtilization(m)?.spend?.percent).toBeCloseTo(20.5155, 4);
  });

  it("a spend with no cap has no percent", () => {
    const spend = metered().cachedUsageUtilization.utilization.spend;
    const m = meteredWith({ spend: { ...spend, limit: null, percent: null } });
    expect(parseUsageUtilization(m)?.spend).toMatchObject({
      used: 410.31,
      limit: null,
      percent: null,
    });
  });

  it("reads a plan's windows that have a number, shortest first, and ignores keys it does not know", () => {
    const limits = parseUsageUtilization(plan());
    expect(limits?.kind).toBe("plan");
    expect(limits?.spend).toBeUndefined();
    expect(limits?.windows).toEqual([
      {
        key: "five_hour",
        label: "5-hour limit",
        percent: 42,
        resetsAt: FETCHED + 10 * HOUR,
        severity: "normal",
      },
      {
        key: "seven_day",
        label: "Weekly limit",
        percent: 63.5,
        resetsAt: FETCHED + 3 * 24 * HOUR,
        severity: "normal",
      },
      {
        key: "seven_day_sonnet",
        label: "Weekly Sonnet limit",
        percent: 7,
        resetsAt: null,
        severity: "normal",
      },
    ]);
  });

  it("a plan with extra usage on keeps both", () => {
    const limits = parseUsageUtilization(
      plan({
        extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1250, currency: "EUR" },
      }),
    );
    expect(limits?.kind).toBe("plan");
    expect(limits?.spend).toMatchObject({ used: 12.5, limit: 50, currency: "EUR", percent: 25 });
  });

  it("an account billed by use is metered even with windows", () => {
    const m = metered();
    m.cachedUsageUtilization.utilization.five_hour = { utilization: 12, resets_at: null } as never;
    expect(parseUsageUtilization(m)?.kind).toBe("metered");
  });

  it("says how close to the limit, by the account's word or by the number", () => {
    const spend = metered().cachedUsageUtilization.utilization.spend;
    const sev = (s: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      parseUsageUtilization(meteredWith({ spend: { ...spend, ...s }, ...extra }))?.spend?.severity;
    expect(sev({ severity: "warning" })).toBe("warning");
    expect(sev({ severity: "critical" })).toBe("critical");
    // a word nobody has seen goes by the number
    expect(sev({ severity: "amber", percent: 85 })).toBe("warning");
    expect(sev({ severity: undefined, percent: 30 })).toBe("normal");
    // the account's normal is believed under the cap
    expect(sev({ severity: "normal", percent: 85 })).toBe("normal");
    expect(sev({ percent: 100 })).toBe("critical");
    expect(
      sev(
        {},
        {
          extra_usage: {
            ...metered().cachedUsageUtilization.utilization.extra_usage,
            spend_limit_reached: true,
          },
        },
      ),
    ).toBe("critical");
    const windows = parseUsageUtilization(
      plan({
        five_hour: { utilization: 91, resets_at: null },
        seven_day: { utilization: 100, resets_at: null },
      }),
    )?.windows;
    expect(windows?.map((w) => w.severity)).toEqual(["warning", "critical", "normal"]);
  });

  it("a cache of another account than the one signed in is nothing", () => {
    const m = metered();
    m.oauthAccount.accountUuid = "00000000-0000-4000-8000-00000000000b";
    expect(parseUsageUtilization(m)).toBeNull();
    // either side missing the id is not a mismatch
    const loose = metered() as { oauthAccount?: unknown };
    delete loose.oauthAccount;
    expect(parseUsageUtilization(loose)?.kind).toBe("metered");
  });

  it("anything else is nothing, and never throws", () => {
    const garbage: unknown[] = [
      null,
      undefined,
      42,
      "{}",
      [],
      {},
      { cachedUsageUtilization: null },
      { cachedUsageUtilization: "x" },
      { cachedUsageUtilization: [] },
      { cachedUsageUtilization: { fetchedAtMs: "yesterday", utilization: {} } },
      { cachedUsageUtilization: { fetchedAtMs: FETCHED } },
      { cachedUsageUtilization: { fetchedAtMs: FETCHED, utilization: [] } },
      // every window null, nothing spent: a fresh account
      { cachedUsageUtilization: { fetchedAtMs: FETCHED, utilization: { five_hour: null } } },
      // the wrong types everywhere
      {
        cachedUsageUtilization: {
          fetchedAtMs: FETCHED,
          utilization: {
            five_hour: { utilization: "42", resets_at: 7 },
            seven_day: "full",
            spend: { used: { amount_minor: "41031" }, enabled: true },
            extra_usage: { is_enabled: "yes" },
          },
        },
      },
      {
        cachedUsageUtilization: {
          fetchedAtMs: Number.NaN,
          utilization: plan().cachedUsageUtilization.utilization,
        },
      },
    ];
    for (const g of garbage) expect(parseUsageUtilization(g), JSON.stringify(g)).toBeNull();
  });

  it("an extra_usage alone, on an account not billed by use, is a plan's: it opens on the API-equivalent", () => {
    // the probe: a plan whose windows have no number yet, with extra usage on
    const probe = {
      oauthAccount: { accountUuid: ACCOUNT, billingType: "stripe_subscription" },
      cachedUsageUtilization: {
        fetchedAtMs: FETCHED,
        accountUuid: ACCOUNT,
        utilization: {
          five_hour: { utilization: null },
          extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 10 },
        },
      },
    };
    const limits = parseUsageUtilization(probe);
    expect(limits).toEqual({
      kind: "plan",
      fetchedAt: FETCHED,
      spend: {
        used: 0.1,
        limit: 50,
        currency: "USD",
        digits: 2,
        percent: 0.2,
        severity: "normal",
      },
      windows: [],
    } satisfies UsageLimits);
    expect(usageModeOf(undefined, limits)).toBe("api-equivalent");
    // a plan's headline is its windows: none here, so the menu bar says nothing
    expect(headlineLimit(limits, NOW)).toBeNull();
    // the same extra_usage on an account billed by use is metered
    const billed = {
      ...probe,
      oauthAccount: { ...probe.oauthAccount, seatTier: "enterprise_usage_based" },
    };
    expect(parseUsageUtilization(billed)?.kind).toBe("metered");
  });

  it("reads limits[] entries with a number as more windows, and drops the ones a named window says", () => {
    const entry = (o: Record<string, unknown>) => ({
      kind: "seven_day",
      group: "models",
      percent: 30,
      resets_at: new Date(FETCHED + 48 * HOUR).toISOString(),
      severity: "normal",
      is_active: true,
      ...o,
    });
    const limits = parseUsageUtilization(
      plan({
        seven_day_opus: { utilization: 12, resets_at: null },
        limits: [
          // a model with no window of its own
          entry({ scope: { model: { display_name: "Fable 5.1" } }, severity: "warning" }),
          // the same as seven_day_opus
          entry({ percent: 12, scope: { model: { display_name: "Opus 5.5" } } }),
          // no number
          entry({ percent: "30", scope: { model: { display_name: "Haiku" } } }),
          "not an entry",
          // a 5-hour one, by its surface
          entry({
            kind: "five_hour",
            percent: 55,
            scope: { surface: { display_name: "Claude Code" } },
          }),
          // neither a period nor a scope it knows
          entry({ kind: "monthly", percent: 3, resets_at: null, severity: undefined }),
        ],
      }),
    );
    expect(limits?.windows.map((w) => [w.key, w.label, w.percent, w.severity])).toEqual([
      ["five_hour", "5-hour limit", 42, "normal"],
      ["seven_day", "Weekly limit", 63.5, "normal"],
      ["seven_day_opus", "Weekly Opus limit", 12, "normal"],
      ["seven_day_sonnet", "Weekly Sonnet limit", 7, "normal"],
      ["limits-0", "Weekly Fable 5.1 limit", 30, "warning"],
      ["limits-4", "5-hour Claude Code limit", 55, "normal"],
      ["limits-5", "Usage limit", 3, "normal"],
    ]);
    expect(limits?.windows[4]?.resetsAt).toBe(FETCHED + 48 * HOUR);
    // on its own, an entry makes a plan
    const only = parseUsageUtilization({
      cachedUsageUtilization: {
        fetchedAtMs: FETCHED,
        utilization: {
          five_hour: null,
          limits: [entry({ scope: { model: { display_name: "Opus" } } })],
        },
      },
    });
    expect(only?.kind).toBe("plan");
    expect(only?.windows).toMatchObject([{ label: "Weekly Opus limit", percent: 30 }]);
  });

  it("a window with a reset date it cannot read has none", () => {
    const limits = parseUsageUtilization(
      plan({ five_hour: { utilization: 5, resets_at: "soon" } }),
    );
    expect(limits?.windows[0]).toMatchObject({ key: "five_hour", resetsAt: null });
  });
});

describe("usageModeOf", () => {
  const m = parseUsageUtilization(metered());
  const p = parseUsageUtilization(plan());
  it("a metered account opens on its own numbers, a plan or nothing on the API-equivalent", () => {
    expect(usageModeOf(undefined, m)).toBe("actual");
    expect(usageModeOf(undefined, p)).toBe("api-equivalent");
    expect(usageModeOf(undefined, null)).toBe("api-equivalent");
  });
  it("what was picked wins", () => {
    expect(usageModeOf("api-equivalent", m)).toBe("api-equivalent");
    expect(usageModeOf("actual", p)).toBe("actual");
    expect(usageModeOf("actual", null)).toBe("actual");
  });
});

describe("headlineLimit", () => {
  it("a metered account's spend against its cap", () => {
    expect(headlineLimit(parseUsageUtilization(metered()), NOW)).toEqual({
      percent: 21,
      label: "$2,000 limit",
      resetsAt: null,
      fetchedAt: FETCHED,
      stale: false,
    });
  });

  it("past a day old, or past the age it is given, it says it is stale", () => {
    const limits = parseUsageUtilization(metered());
    expect(headlineLimit(limits, FETCHED + 24 * HOUR)?.stale).toBe(false);
    expect(headlineLimit(limits, FETCHED + 27 * HOUR)).toMatchObject({ percent: 21, stale: true });
    expect(headlineLimit(limits, NOW, 2 * HOUR)?.stale).toBe(true);
    expect(headlineLimit(parseUsageUtilization(plan()), NOW, 9 * HOUR)?.stale).toBe(false);
  });

  it("the plan window nearest its limit, leaving out one that started over since", () => {
    const limits = parseUsageUtilization(plan());
    expect(headlineLimit(limits, NOW)).toMatchObject({ percent: 63.5, label: "Weekly limit" });
    const hot = parseUsageUtilization(
      plan({ five_hour: { utilization: 90, resets_at: new Date(FETCHED + HOUR).toISOString() } }),
    );
    // the 5-hour window is at 90, but it reset 7 hours ago
    expect(headlineLimit(hot, FETCHED + 30 * MIN)).toMatchObject({
      percent: 90,
      label: "5-hour limit",
    });
    expect(headlineLimit(hot, NOW)).toMatchObject({ percent: 63.5, label: "Weekly limit" });
  });

  it("nothing with no limit", () => {
    expect(headlineLimit(null, NOW)).toBeNull();
    const spend = metered().cachedUsageUtilization.utilization.spend;
    expect(
      headlineLimit(parseUsageUtilization(meteredWith({ spend: { ...spend, limit: null } })), NOW),
    ).toBeNull();
  });
});

describe("the words", () => {
  it("money in its currency, cents only when there are some", () => {
    expect(formatMoney(410.31, "USD")).toBe("$410.31");
    expect(formatMoney(2000, "USD")).toBe("$2,000");
    expect(formatMoney(12.5, "EUR")).toBe("€12.50");
    expect(formatMoney(3, "not a code")).toBe("3 not a code");
  });

  it("a span in its two largest units", () => {
    expect(formatSpan(20_000)).toBe("<1m");
    expect(formatSpan(42 * MIN)).toBe("42m");
    expect(formatSpan(2 * HOUR)).toBe("2h");
    expect(formatSpan(2 * HOUR + 10 * MIN + 59_000)).toBe("2h 10m");
    expect(formatSpan(3 * 24 * HOUR + 4 * HOUR + 30 * MIN)).toBe("3d 4h");
    expect(formatSpan(6 * 24 * HOUR)).toBe("6d");
  });

  it("when a window starts over", () => {
    expect(resetWords(NOW + 2 * HOUR + 10 * MIN, NOW)).toBe("resets in 2h 10m");
    expect(resetWords(NOW - HOUR, NOW)).toBe("reset 1h ago");
  });
});

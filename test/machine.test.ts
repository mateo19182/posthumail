import { describe, expect, test } from "bun:test";
import { durations } from "../src/config.ts";
import * as M from "../src/machine.ts";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const d = durations({
  checkinEvery: "30d",
  grace: "21d",
  remindEvery: "4d",
  trusteeStagger: "3d",
  trusteeReask: "7d",
  cooling: "48h",
  coolingPingEvery: "6h",
  maxPause: "180d",
});
const ctx: M.Ctx = { d, trustees: ["a", "b", "c"], quorum: 2 };

// Run the hourly cron from `from` to `to`, collecting actions. Owner pings are
// delivered immediately unless `delivered` says otherwise.
const run = (s: M.State, from: number, to: number, delivered = (_t: number) => true) => {
  const actions: { at: number; action: M.Action }[] = [];
  for (let t = from; t <= to; t += HOUR) {
    const r = M.tick(s, t, ctx);
    s = r.state;
    if (r.actions.some((a) => a.kind === "ownerPing")) s = delivered(t) ? M.pingDelivered(s, t) : M.pingFailed(s, t);
    actions.push(...r.actions.map((action) => ({ at: t, action })));
  }
  return { s, actions };
};

const confirm = (s: M.State, t: number, id: string) => {
  const r = M.trusteeConfirm(s, t, id, ctx);
  return { ...r, state: r.actions.some((a) => a.kind === "ownerPing") ? M.pingDelivered(r.state, t) : r.state };
};

const kinds = (xs: { action: M.Action }[]) => xs.map((x) => x.action.kind);

describe("check-ins", () => {
  test("quiet until due, then pings and reminds", () => {
    const { s, actions } = run(M.initial(0), 0, 50 * DAY);
    expect(s.phase).toBe("alive");
    const pings = actions.filter((a) => a.action.kind === "ownerPing");
    expect(pings[0]!.at).toBe(30 * DAY);
    expect(pings.length).toBe(1 + Math.floor(20 / 4));
  });

  test("checkin resets the clock", () => {
    let { s } = run(M.initial(0), 0, 40 * DAY);
    s = M.checkin(s, 40 * DAY).state;
    const r = run(s, 40 * DAY, 69 * DAY);
    expect(kinds(r.actions)).toEqual([]);
  });

  test("pause postpones the first ping and is capped", () => {
    let s = M.pause(M.initial(0), 0, 60 * DAY, d).state;
    expect(M.dueAt(s, d)).toBe(60 * DAY);
    s = M.pause(M.initial(0), 0, 999 * DAY, d).state;
    expect(s.pausedUntil).toBe(180 * DAY);
  });
});

describe("trustees", () => {
  const asking = () => run(M.initial(0), 0, 51 * DAY).s;

  test("asks after grace, staggered", () => {
    const { s, actions } = run(M.initial(0), 0, 58 * DAY);
    expect(s.phase).toBe("asking");
    const asks = actions.filter((a) => a.action.kind === "askTrustee");
    expect(asks.map((a) => [(a.action as any).id, (a.at - 51 * DAY) / DAY])).toEqual([
      ["a", 0],
      ["b", 3],
      ["c", 6],
      ["a", 7],
    ]);
  });

  test("never releases without quorum", () => {
    const { s } = run(asking(), 51 * DAY, 400 * DAY);
    expect(s.phase).toBe("asking");
  });

  test("one confirmation is not enough, two start cooling, then release", () => {
    let s = asking();
    s = M.trusteeConfirm(s, 52 * DAY, "a", ctx).state;
    expect(s.phase).toBe("asking");
    s = M.trusteeConfirm(s, 52 * DAY, "a", ctx).state;
    expect(Object.keys(s.confirmed)).toEqual(["a"]);
    const r = confirm(s, 53 * DAY, "b");
    expect(r.state.phase).toBe("cooling");
    expect(r.actions.map((a) => a.kind)).toContain("cooling");
    const done = run(r.state, 53 * DAY, 53 * DAY + 49 * HOUR);
    expect(done.s.phase).toBe("released");
    expect(kinds(done.actions).filter((k) => k === "release").length).toBe(1);
    expect(kinds(done.actions).filter((k) => k === "ownerPing").length).toBe(7);
  });

  test("pings that are never delivered never lead to asking trustees", () => {
    const { s, actions } = run(M.initial(0), 0, 200 * DAY, () => false);
    expect(s.phase).toBe("alive");
    expect(actions.filter((a) => a.action.kind === "askTrustee").length).toBe(0);
    // Failed pings are retried every 6 hours.
    expect(actions.filter((a) => a.action.kind === "ownerPing").length).toBe(170 * 4 + 1);
  });

  test("asking waits for the second delivered ping", () => {
    // Only pings from day 60 on get through.
    const { s } = run(M.initial(0), 0, 61 * DAY, (t) => t >= 60 * DAY);
    expect(s.phase).toBe("alive");
    expect(s.pingsDelivered).toBe(1);
    expect(run(s, 61 * DAY, 64 * DAY + HOUR, () => true).s.phase).toBe("asking");
  });

  test("cooling counts from the first delivered urgent ping", () => {
    let s = asking();
    s = M.trusteeConfirm(s, 52 * DAY, "a", ctx).state;
    s = M.trusteeConfirm(s, 52 * DAY, "b", ctx).state;
    s = M.pingFailed(s, 52 * DAY - 6 * HOUR);
    // Undelivered for 3 days: no release, retries every 6 hours.
    let r = run(s, 52 * DAY, 55 * DAY - HOUR, () => false);
    expect(r.s.phase).toBe("cooling");
    expect(r.s.coolingNoticeAt).toBeNull();
    r = run(r.s, 55 * DAY, 55 * DAY + 47 * HOUR);
    expect(r.s.coolingNoticeAt).toBe(55 * DAY);
    expect(r.s.phase).toBe("cooling");
    expect(run(r.s, 55 * DAY + 48 * HOUR, 55 * DAY + 48 * HOUR).s.phase).toBe("released");
  });

  test("an ask that reached nobody is retried next tick", () => {
    let s = asking();
    s = M.askFailed(s, "a");
    expect(M.tick(s, 51 * DAY + HOUR, ctx).actions).toContainEqual({ kind: "askTrustee", id: "a", again: false });
  });

  test("owner can cancel during cooling", () => {
    let s = asking();
    s = M.trusteeConfirm(s, 52 * DAY, "a", ctx).state;
    s = M.trusteeConfirm(s, 52 * DAY, "b", ctx).state;
    const r = M.checkin(s, 53 * DAY);
    expect(r.state.phase).toBe("alive");
    expect(r.actions).toEqual([{ kind: "falseAlarm", trustees: ["a"], by: "owner" }]);
  });

  test("a trustee saying fine resets everything", () => {
    let s = run(M.initial(0), 0, 55 * DAY).s;
    s = M.trusteeConfirm(s, 55 * DAY, "a", ctx).state;
    const r = M.trusteeFine(s, 55 * DAY, "c");
    expect(r.state.phase).toBe("alive");
    expect(r.state.confirmed).toEqual({});
    expect(r.state.lastCheckin).toBe(55 * DAY);
    expect(r.actions[0]).toEqual({ kind: "falseAlarm", trustees: ["a", "b"], by: "c" });
  });

  test("released is final", () => {
    const s = { ...M.initial(0), phase: "released" as const };
    expect(M.checkin(s, 1).state).toBe(s);
    expect(M.trusteeFine(s, 1, "a").state).toBe(s);
  });
});

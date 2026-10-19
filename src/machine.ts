import type { Durations } from "./config.ts";

export type Phase = "alive" | "asking" | "cooling" | "released";

export interface State {
  phase: Phase;
  lastCheckin: number;
  pausedUntil: number | null;
  lastOwnerPing: number | null;
  askingSince: number | null;
  asked: Record<string, number>;
  confirmed: Record<string, number>;
  coolingSince: number | null;
  releasedAt: number | null;
}

export type Action =
  | { kind: "ownerPing"; reminder: boolean; urgent: boolean }
  | { kind: "askTrustee"; id: string; again: boolean }
  | { kind: "cooling"; until: number }
  | { kind: "falseAlarm"; trustees: string[]; by: "owner" | string }
  | { kind: "trusteeConfirmed"; id: string; count: number }
  | { kind: "release" };

export interface Step {
  state: State;
  actions: Action[];
}

export interface Ctx {
  d: Durations;
  trustees: string[];
  quorum: number;
}

export const initial = (now: number): State => ({
  phase: "alive",
  lastCheckin: now,
  pausedUntil: null,
  lastOwnerPing: null,
  askingSince: null,
  asked: {},
  confirmed: {},
  coolingSince: null,
  releasedAt: null,
});

export const dueAt = (s: State, d: Durations): number =>
  Math.max(s.lastCheckin + d.checkinEvery, s.pausedUntil ?? 0);

const reset = (s: State, now: number): State => ({
  ...initial(now),
  pausedUntil: s.pausedUntil && s.pausedUntil > now ? s.pausedUntil : null,
});

const notifyFalseAlarm = (s: State, by: string): Action[] => {
  const trustees = Object.keys(s.asked);
  return trustees.length ? [{ kind: "falseAlarm", trustees, by }] : [];
};

export const tick = (s: State, now: number, { d, trustees, quorum }: Ctx): Step => {
  const actions: Action[] = [];
  if (s.phase === "released") return { state: s, actions };

  if (s.phase === "cooling") {
    if (now >= s.coolingSince! + d.cooling) {
      return { state: { ...s, phase: "released", releasedAt: now }, actions: [{ kind: "release" }] };
    }
    if (now - (s.lastOwnerPing ?? 0) >= d.coolingPingEvery) {
      actions.push({ kind: "ownerPing", reminder: true, urgent: true });
      s = { ...s, lastOwnerPing: now };
    }
    return { state: s, actions };
  }

  const due = dueAt(s, d);
  if (now < due) return { state: s, actions };

  if (s.lastOwnerPing === null || s.lastOwnerPing < due) {
    actions.push({ kind: "ownerPing", reminder: false, urgent: false });
    s = { ...s, lastOwnerPing: now };
  } else if (now - s.lastOwnerPing >= d.remindEvery) {
    actions.push({ kind: "ownerPing", reminder: true, urgent: s.phase === "asking" });
    s = { ...s, lastOwnerPing: now };
  }

  if (s.phase === "alive" && now >= due + d.grace) s = { ...s, phase: "asking", askingSince: now };

  if (s.phase === "asking") {
    const asked = { ...s.asked };
    trustees.forEach((id, i) => {
      if (s.confirmed[id]) return;
      const last = asked[id];
      if (last === undefined) {
        if (now >= s.askingSince! + i * d.trusteeStagger) {
          actions.push({ kind: "askTrustee", id, again: false });
          asked[id] = now;
        }
      } else if (now - last >= d.trusteeReask) {
        actions.push({ kind: "askTrustee", id, again: true });
        asked[id] = now;
      }
    });
    s = { ...s, asked };
  }

  return { state: s, actions };
};

export const checkin = (s: State, now: number): Step => {
  if (s.phase === "released") return { state: s, actions: [] };
  return { state: { ...reset(s, now), pausedUntil: null }, actions: notifyFalseAlarm(s, "owner") };
};

export const pause = (s: State, now: number, ms: number, d: Durations): Step => {
  if (s.phase === "released") return { state: s, actions: [] };
  const until = now + Math.min(ms, d.maxPause);
  return { state: { ...reset(s, now), pausedUntil: until }, actions: notifyFalseAlarm(s, "owner") };
};

export const resume = (s: State, now: number): Step =>
  s.phase === "released" ? { state: s, actions: [] } : { state: { ...s, pausedUntil: null, lastCheckin: now }, actions: [] };

export const trusteeFine = (s: State, now: number, id: string): Step => {
  if (s.phase !== "asking" && s.phase !== "cooling") return { state: s, actions: [] };
  return { state: reset(s, now), actions: notifyFalseAlarm(s, id) };
};

export const trusteeConfirm = (s: State, now: number, id: string, { d, quorum }: Ctx): Step => {
  if (s.phase !== "asking" || s.confirmed[id]) return { state: s, actions: [] };
  const confirmed = { ...s.confirmed, [id]: now };
  const count = Object.keys(confirmed).length;
  const actions: Action[] = [{ kind: "trusteeConfirmed", id, count }];
  if (count < quorum) return { state: { ...s, confirmed }, actions };
  const until = now + d.cooling;
  actions.push({ kind: "cooling", until }, { kind: "ownerPing", reminder: true, urgent: true });
  return {
    state: { ...s, confirmed, phase: "cooling", coolingSince: now, lastOwnerPing: now },
    actions,
  };
};

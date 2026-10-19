import type { Durations } from "./config.ts";

export type Phase = "alive" | "asking" | "cooling" | "released";

export interface State {
  phase: Phase;
  lastCheckin: number;
  pausedUntil: number | null;
  // Time of the last owner ping that was actually delivered.
  lastOwnerPing: number | null;
  // A ping was sent and its delivery is not yet known; no new ping until it resolves.
  pingInFlight: boolean;
  // After an undelivered ping, wait before retrying so a bouncing address isn't hammered.
  pingRetryAt: number | null;
  // Delivered pings since the check-in was due; trustees are only asked after `MIN_DELIVERED`.
  pingsDelivered: number;
  askingSince: number | null;
  asked: Record<string, number>;
  confirmed: Record<string, number>;
  coolingSince: number | null;
  // First urgent ping delivered during cooling; the cooling period counts from here.
  coolingNoticeAt: number | null;
  releasedAt: number | null;
}

export const MIN_DELIVERED = 2;
export const PING_RETRY = 6 * 3_600_000;

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
  pingInFlight: false,
  pingRetryAt: null,
  pingsDelivered: 0,
  askingSince: null,
  asked: {},
  confirmed: {},
  coolingSince: null,
  coolingNoticeAt: null,
  releasedAt: null,
});

// States stored before a field existed get its initial value.
export const normalize = (s: Partial<State>): State => ({ ...initial(s.lastCheckin ?? 0), ...s });

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

const canPing = (s: State, now: number) => !s.pingInFlight && (s.pingRetryAt === null || now >= s.pingRetryAt);

const ping = (s: State, actions: Action[], reminder: boolean, urgent: boolean): State => {
  actions.push({ kind: "ownerPing", reminder, urgent });
  return { ...s, pingInFlight: true };
};

export const tick = (s: State, now: number, { d, trustees }: Ctx): Step => {
  const actions: Action[] = [];
  if (s.phase === "released") return { state: s, actions };

  if (s.phase === "cooling") {
    if (s.coolingNoticeAt !== null && now >= s.coolingNoticeAt + d.cooling) {
      return { state: { ...s, phase: "released", releasedAt: now }, actions: [{ kind: "release" }] };
    }
    const sinceNotice = s.coolingNoticeAt === null ? Infinity : now - (s.lastOwnerPing ?? 0);
    if (canPing(s, now) && sinceNotice >= d.coolingPingEvery) s = ping(s, actions, true, true);
    return { state: s, actions };
  }

  const due = dueAt(s, d);
  if (now < due) return { state: s, actions };

  if (canPing(s, now)) {
    if (s.lastOwnerPing === null || s.lastOwnerPing < due) s = ping(s, actions, false, false);
    else if (now - s.lastOwnerPing >= d.remindEvery) s = ping(s, actions, true, s.phase === "asking");
  }

  if (s.phase === "alive" && now >= due + d.grace && s.pingsDelivered >= MIN_DELIVERED)
    s = { ...s, phase: "asking", askingSince: now };

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

// Delivery results for owner pings and trustee asks, reported back by the app.
export const pingDelivered = (s: State, at: number): State => {
  if (!s.pingInFlight) return s;
  const next = { ...s, pingInFlight: false, pingRetryAt: null, lastOwnerPing: at, pingsDelivered: s.pingsDelivered + 1 };
  return s.phase === "cooling" && s.coolingNoticeAt === null ? { ...next, coolingNoticeAt: at } : next;
};

export const pingFailed = (s: State, now: number): State =>
  s.pingInFlight ? { ...s, pingInFlight: false, pingRetryAt: now + PING_RETRY } : s;

// An ask that reached nobody is retried on the next tick instead of after `trusteeReask`.
export const askFailed = (s: State, id: string): State => {
  if (s.phase !== "asking" || s.asked[id] === undefined) return s;
  const { [id]: _, ...asked } = s.asked;
  return { ...s, asked };
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
  actions.push({ kind: "cooling", until });
  const cooling: State = { ...s, confirmed, phase: "cooling", coolingSince: now, coolingNoticeAt: null, pingInFlight: false };
  return { state: ping(cooling, actions, true, true), actions };
};

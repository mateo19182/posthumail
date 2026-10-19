export interface Person {
  id: string;
  name: string;
  email: string;
  // false when the address is already a verified destination managed elsewhere,
  // so `alchemy destroy` never deletes it.
  manageAddress?: boolean;
}

export interface Timing {
  checkinEvery: string;
  grace: string;
  remindEvery: string;
  trusteeStagger: string;
  trusteeReask: string;
  cooling: string;
  coolingPingEvery: string;
  maxPause: string;
}

export interface Config {
  owner: Person;
  trustees: Person[];
  recipients: Person[];
  quorum: number;
  from: string;
  domain: string;
  cron: string;
  timing: Timing;
}

export type Durations = { [K in keyof Timing]: number };

const UNITS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

export const parseDuration = (s: string): number => {
  const m = /^(\d+(?:\.\d+)?)\s*([mhd])$/.exec(s.trim());
  if (!m) throw new Error(`bad duration: ${s}`);
  return Number(m[1]) * UNITS[m[2]!]!;
};

export const durations = (t: Timing): Durations =>
  Object.fromEntries(Object.entries(t).map(([k, v]) => [k, parseDuration(v)])) as Durations;

export const people = (c: Config): Person[] => [c.owner, ...c.trustees, ...c.recipients];

export const validate = (c: Config): Config => {
  durations(c.timing);
  const ids = people(c).map((p) => p.id);
  const bad = ids.find((id) => !/^[a-z0-9-]{1,32}$/.test(id));
  if (bad !== undefined) throw new Error(`person id must match [a-z0-9-]{1,32}: ${bad}`);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) throw new Error(`duplicate person id: ${dup}`);
  if (c.quorum < 1 || c.quorum > c.trustees.length)
    throw new Error(`quorum ${c.quorum} must be between 1 and ${c.trustees.length}`);
  return c;
};

import type { Config } from "./src/config.ts";

// Copy to posthumail.config.ts (gitignored). Person ids: [a-z0-9-], used in messages' `to:`.
export default {
  owner: { id: "me", name: "Me", email: "me@example.com" },
  trustees: [
    { id: "ana", name: "Ana", email: "ana@example.com" },
    { id: "luis", name: "Luis", email: "luis@example.com" },
    { id: "eva", name: "Eva", email: "eva@example.com" },
  ],
  quorum: 2,
  from: "posthumail@example.com",
  domain: "posthumail.example.com",
  cron: "0 * * * *",
  timing: {
    checkinEvery: "30d",
    grace: "21d",
    remindEvery: "4d",
    trusteeStagger: "3d",
    trusteeReask: "7d",
    cooling: "48h",
    coolingPingEvery: "6h",
    maxPause: "180d",
  },
  // Resend segment that gets messages addressed `to: all`.
  killswitch: {
    segmentId: "<resend-segment-id>",
    from: "Me <killswitch@example.com>",
  },
  // Blog newsletter "Quarterly life updates" segment in Resend.
  updates: {
    segmentId: "<resend-segment-id>",
    from: "Me <updates@example.com>",
    archiveUrl: "https://blog.example.com/updates",
  },
} satisfies Config;

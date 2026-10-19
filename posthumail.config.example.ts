import type { Config } from "./src/config.ts";

// Copy to posthumail.config.ts (gitignored). Person ids: [a-z0-9-], used in messages' `to:`.
export default {
  owner: { id: "me", name: "Mateo", email: "me@example.com" },
  trustees: [
    { id: "ana", name: "Ana", email: "ana@example.com" },
    { id: "luis", name: "Luis", email: "luis@example.com" },
    { id: "eva", name: "Eva", email: "eva@example.com" },
  ],
  recipients: [{ id: "mama", name: "Mamá", email: "mama@example.com" }],
  quorum: 2,
  from: "posthumail@m19182.dev",
  domain: "posthumail.m19182.dev",
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
  // Blog newsletter "Quarterly life updates" segment in Resend.
  updates: {
    segmentId: "34ddbeff-78cb-4190-9a29-a6746457c728",
    from: "Mateo <updates@m19182.dev>",
    remind: true,
    archiveUrl: "https://blog.m19182.dev/now#quarterly-life-updates",
  },
} satisfies Config;

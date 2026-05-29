import { DEFAULT_AGENT_MATCHERS, detectAgents, psProcessLister } from "@vesper/core";
import type { PresenceInfo } from "../world/types.ts";

/** Detects the agents currently running on this machine. Injectable for tests. */
export type PresenceDetector = () => Promise<PresenceInfo[]>;

/**
 * Default detector: scan the process table (`ps`) for the built-in agent
 * allowlist and map to {@link PresenceInfo}. Failure-safe — if `ps` is
 * unavailable the world simply shows no live agents rather than erroring.
 */
export function defaultPresenceDetector(): PresenceDetector {
  const lister = psProcessLister();
  return async (): Promise<PresenceInfo[]> => {
    try {
      const rows = await lister.list();
      return detectAgents(rows, DEFAULT_AGENT_MATCHERS).map((p) => ({
        id: p.id,
        label: p.label,
        kind: p.kind,
        since: p.since,
        procCount: p.procCount,
      }));
    } catch {
      return [];
    }
  };
}

/**
 * A cheap, order-independent signature of the presence set — changes only when an
 * agent starts/stops or its process count changes, so the poll loop pushes an
 * update only on a real change (not every tick).
 */
export function presenceSignature(presences: readonly PresenceInfo[]): string {
  return presences
    .map((p) => `${p.id}:${p.procCount}`)
    .sort()
    .join("|");
}

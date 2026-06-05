import {
  type AgentMatcherSpec,
  DEFAULT_AGENT_MATCHERS,
  detectAgents,
  psProcessLister,
} from "@vesper/core";
import type { PresenceInfo } from "../world/types.ts";

/** Detects the agents currently running on this machine. Injectable for tests. */
export type PresenceDetector = () => Promise<PresenceInfo[]>;

/**
 * Build a detector that scans the process table (`ps`) for the given matcher
 * allowlist and maps hits to {@link PresenceInfo}. Failure-safe — if `ps` is
 * unavailable the world simply shows no live agents rather than erroring.
 *
 * The daemon builds this from the built-in defaults plus any
 * `presence.matchers` configured in `~/.vesper/config.json`.
 */
export function presenceDetectorFor(matchers: readonly AgentMatcherSpec[]): PresenceDetector {
  const lister = psProcessLister();
  return async (): Promise<PresenceInfo[]> => {
    try {
      const rows = await lister.list();
      return detectAgents(rows, matchers).map((p) => ({
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

/** Default detector over the built-in agent allowlist ({@link DEFAULT_AGENT_MATCHERS}). */
export function defaultPresenceDetector(): PresenceDetector {
  return presenceDetectorFor(DEFAULT_AGENT_MATCHERS);
}

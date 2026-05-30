import { SkillTrainError } from "./errors.ts";

/**
 * Adopt a trained `best.md` candidate into the committed `.ai/skills/<name>/SKILL.md`
 * (the IMPROVE write-back, Forge Slice 4). This is the ONLY path by which an
 * optimized skill body graduates from the per-developer training state into the
 * durable, committed artifact — and it is always behind an explicit human ack at
 * the CLI layer (never autonomous).
 *
 * The operation is `quarantine-then-promote`: the PRE-WRITE committed bytes are
 * snapshotted to a checkpoint FIRST, so a later {@link revertSkill} restores the
 * exact prior bytes without relying on git. All side effects are injected so the
 * core stays pure and deterministically testable.
 */
export interface AcceptDeps {
  readonly name: string;
  /** Current committed SKILL.md body, or `null` if the file is missing. */
  readonly readCommitted: () => Promise<string | null>;
  /** Current trained candidate (best.md) body, or `null` if training never ran. */
  readonly readBest: () => Promise<string | null>;
  /** Overwrite the committed SKILL.md. */
  readonly writeCommitted: (body: string) => Promise<void>;
  /** Snapshot the prior committed body before overwriting; returns the checkpoint path. */
  readonly writeCheckpoint: (body: string, at: number) => Promise<string>;
  /** Clock for the checkpoint timestamp (Unix ms). */
  readonly now: () => number;
}

export type AcceptResult =
  | { readonly outcome: "accepted"; readonly checkpoint: string }
  | { readonly outcome: "no_change" };

/**
 * Promote `best.md` into the committed SKILL.md, checkpointing the prior bytes.
 *
 * Throws {@link SkillTrainError}: `no_candidate` (no trained best.md yet) or
 * `skill_not_found` (no committed SKILL.md to update). Returns `no_change` when
 * the candidate already matches what is committed (nothing to write).
 */
export async function acceptBest(deps: AcceptDeps): Promise<AcceptResult> {
  const best = await deps.readBest();
  if (best === null) {
    throw new SkillTrainError(
      "no_candidate",
      `no trained candidate (best.md) for "${deps.name}" — run \`vesper skill train ${deps.name}\` first`,
    );
  }
  const committed = await deps.readCommitted();
  if (committed === null) {
    throw new SkillTrainError(
      "skill_not_found",
      `no committed SKILL.md for "${deps.name}" to update`,
    );
  }
  if (committed === best) return { outcome: "no_change" };

  const checkpoint = await deps.writeCheckpoint(committed, deps.now());
  await deps.writeCommitted(best);
  return { outcome: "accepted", checkpoint };
}

/**
 * Restore the committed SKILL.md from the most recent checkpoint — the exact
 * undo of the last {@link acceptBest}. Side effects injected for testability.
 */
export interface RevertDeps {
  readonly name: string;
  readonly readCommitted: () => Promise<string | null>;
  readonly readLatestCheckpoint: () => Promise<string | null>;
  readonly writeCommitted: (body: string) => Promise<void>;
}

export type RevertResult =
  | { readonly outcome: "reverted" }
  | { readonly outcome: "no_change" }
  | { readonly outcome: "no_checkpoint" };

/**
 * Restore the committed SKILL.md to the latest checkpoint. Returns `no_checkpoint`
 * when nothing was ever accepted, `no_change` when the committed body already
 * matches the checkpoint, else `reverted`.
 */
export async function revertSkill(deps: RevertDeps): Promise<RevertResult> {
  const checkpoint = await deps.readLatestCheckpoint();
  if (checkpoint === null) return { outcome: "no_checkpoint" };
  const committed = await deps.readCommitted();
  if (committed === checkpoint) return { outcome: "no_change" };

  await deps.writeCommitted(checkpoint);
  return { outcome: "reverted" };
}

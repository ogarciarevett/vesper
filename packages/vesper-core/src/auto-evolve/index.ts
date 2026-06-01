// auto-evolve module public surface — scheduled reflect -> propose -> gated-additive
// skill acquisition. All pure (injected complete/process seams); no I/O here.

export type { GatherDeps, GatherParams } from "./gather.ts";
export { gatherSignals } from "./gather.ts";
export type { ParseResult } from "./parse.ts";
export { parseEvolveReport } from "./parse.ts";
export { buildReflectPrompt } from "./reflect.ts";
export { ALLOWED_SKILL_SOURCES, isAllowedSkillName } from "./skill-name.ts";
export type {
  EvolveReport,
  EvolveSignals,
  FixProposal,
  PipelineRunRollup,
  SkillProposal,
  TaskError,
} from "./types.ts";

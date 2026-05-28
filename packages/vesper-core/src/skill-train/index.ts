// skill-train module public surface — SkillOpt-style skill optimization.

export type { SkillTrainErrorReason } from "./errors.ts";
export { SkillTrainError } from "./errors.ts";
export { parseFrontmatter } from "./frontmatter.ts";
export { assertSkillName } from "./name.ts";
export { buildOptimizerPrompt, type OptimizerInput, parseCandidate } from "./optimizer.ts";
export { SkillTrainStore } from "./persistence.ts";
export { contains, exactMatch, makeJudge, resolveScorer } from "./scorers.ts";
export { type LoadSkillOptions, loadSkill } from "./skill.ts";
export { splitTasks, type TrainOptions, type TrainResult, trainSkill } from "./train.ts";
export type {
  HistoryEntry,
  Scorer,
  ScorerName,
  Skill,
  SkillFrontmatter,
  SkillTask,
  TrajectoryResult,
} from "./types.ts";

// @vesper/ui — the local Vesper desktop UI (native companion shell + Chat).

export { ModuleRegistry } from "./modules/registry.ts";
export type { UiModule } from "./modules/types.ts";
export {
  defaultPresenceDetector,
  type PresenceDetector,
  presenceDetectorFor,
} from "./server/presence.ts";
export {
  buildClientAssets,
  type ClientAssets,
  setEmbeddedClientAssets,
  startUiServer,
  type UiServerDeps,
  type UiServerHandle,
} from "./server/server.ts";
export type {
  PresenceInfo,
  RunEventInfo,
  RunTreeInfo,
  SkillDetail,
  SkillHistoryView,
  SkillSummary,
  SkillTaskView,
  SweDiffHunk,
  SweDiffLine,
  SweDiffView,
  SweFileDiff,
} from "./world/types.ts";

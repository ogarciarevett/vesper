// @vesper/ui — the local pixel-art Agent-OS UI ("Vesper World").

export { ModuleRegistry } from "./modules/registry.ts";
export type { AgentAddon, AgentAffordance, AgentDecoration, UiModule } from "./modules/types.ts";
export {
  defaultPresenceDetector,
  type PresenceDetector,
  presenceDetectorFor,
  presenceSignature,
} from "./server/presence.ts";
export { startUiServer, type UiServerDeps, type UiServerHandle } from "./server/server.ts";
export { buildSnapshot } from "./server/snapshot.ts";
export { buildWorld } from "./world/build.ts";
export { fnv1a, seededUnit } from "./world/hash.ts";
export type {
  AgentMood,
  Inhabitant,
  PipelineInfo,
  PresenceInfo,
  RunInfo,
  SceneGraph,
  WorldSnapshot,
} from "./world/types.ts";

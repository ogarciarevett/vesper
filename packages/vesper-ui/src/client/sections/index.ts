import type { SectionModule } from "../shell/section.ts";
import { aboutSection } from "./about.ts";
import { channelsSection } from "./channels.ts";
import { chatSection } from "./chat.ts";
import { cliSection } from "./cli.ts";
import { diagnosticsSection } from "./diagnostics.ts";
import { memorySection } from "./memory.ts";
import { permissionsSection } from "./permissions.ts";
import { pipelinesSection } from "./pipelines.ts";
import { runtimeSection } from "./runtime.ts";
import { sandboxSection } from "./sandbox.ts";
import { scheduleSection } from "./schedule.ts";
import { settingsSection } from "./settings.ts";
import { skillsSection } from "./skills.ts";
import { voiceSection } from "./voice.ts";

/**
 * Every section the shell registers, in display order. The sidebar groups them by
 * `section.group` (primary | vesper | computer) preserving this array order within
 * each group. "Real" sections (Chat, Runtime, CLIs, Permissions, Sandbox, Settings,
 * Diagnostics, About) read live state; Channels/Schedule/Pipelines are thin views;
 * Skills is a live read-only library; Voice is the in-window "Talk to Vesper" (Mode A)
 * surface; Memory wires to the RAG status seam (scaffolded, model deferred).
 */
export const ALL_SECTIONS: readonly SectionModule[] = [
  chatSection,
  // Vesper
  pipelinesSection,
  channelsSection,
  scheduleSection,
  skillsSection,
  memorySection,
  // This Computer
  runtimeSection,
  cliSection,
  permissionsSection,
  sandboxSection,
  voiceSection,
  settingsSection,
  diagnosticsSection,
  aboutSection,
];

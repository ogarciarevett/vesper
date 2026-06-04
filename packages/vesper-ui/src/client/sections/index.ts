import type { SectionModule } from "../shell/section.ts";
import { aboutSection } from "./about.ts";
import { channelsSection } from "./channels.ts";
import { chatSection } from "./chat.ts";
import { cliSection } from "./cli.ts";
import { diagnosticsSection } from "./diagnostics.ts";
import { permissionsSection } from "./permissions.ts";
import { pipelinesSection } from "./pipelines.ts";
import { runtimeSection } from "./runtime.ts";
import { sandboxSection } from "./sandbox.ts";
import { scheduleSection } from "./schedule.ts";
import { settingsSection } from "./settings.ts";
import { memorySection, skillsSection, voiceSection } from "./stubs.ts";

/**
 * Every section the shell registers, in display order. The sidebar groups them by
 * `section.group` (primary | vesper | computer) preserving this array order within
 * each group. "Real" sections (Chat, Runtime, CLIs, Permissions, Sandbox, Settings,
 * Diagnostics, About) read live state; Channels/Schedule/Pipelines are thin views;
 * Skills/Memory/Voice are honest stubs pointing at their owning specs.
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

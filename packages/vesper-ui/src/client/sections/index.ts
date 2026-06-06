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
import { skillsSection } from "./skills.ts";
import { memorySection } from "./stubs.ts";
import { voiceSection } from "./voice.ts";

/**
 * Every section the shell registers, in display order. The sidebar groups them by
 * `section.group` (primary | vesper | computer) preserving this array order within
 * each group. "Real" sections (Chat, Runtime, CLIs, Permissions, Sandbox, Settings,
 * Diagnostics, About) read live state; Channels/Schedule/Pipelines are thin views;
 * Memory is an honest stub pointing at its owning spec; Skills is a live read-only
 * library view; Voice is a live in-window "Talk to Vesper" (Mode A) surface.
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

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

/**
 * Every section the shell registers, in display order. The sidebar groups them by
 * `section.group` (primary | vesper | computer) preserving this array order within
 * each group. "Real" sections (Chat, Runtime, CLIs, Permissions, Sandbox, Settings,
 * Diagnostics, About) read live state; Channels/Schedule/Pipelines are thin views;
 * Skills is a live read-only library; Memory wires to the RAG status seam
 * (scaffolded, model deferred). Voice is NOT a section: voice input + spoken
 * replies live in the chat composer, and the voice provider is a Settings card.
 * The autonomous loop lives inside the Pipelines editor (the "Autonomous step"
 * palette entry + the "Start autonomous" launcher), not as its own section.
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
  settingsSection,
  diagnosticsSection,
  aboutSection,
];

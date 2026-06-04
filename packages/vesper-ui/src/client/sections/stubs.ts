import { ICONS } from "../shell/icons.ts";
import type { SectionModule } from "../shell/section.ts";
import { stubSection } from "./stub.ts";

/** Skills-train — the per-role skill optimizer (skill-train engine). */
export const skillsSection: SectionModule = stubSection({
  id: "skills",
  title: "Skills",
  group: "vesper",
  glyph: ICONS.skills,
  blurb:
    "Train per-role skills for your pipelines — scorers, an optimizer, and held-out validation. The engine ships in vesper-core; this surface will let you train, list, and diff skills here.",
  spec: "specs/skill-train.md",
});

/** Memory — the RAG memory surface. */
export const memorySection: SectionModule = stubSection({
  id: "memory",
  title: "Memory",
  group: "vesper",
  glyph: ICONS.memory,
  blurb:
    "Vesper's long-term memory — what it has learned and can recall across runs. A searchable view of stored memory lands here.",
  spec: "specs/rag-memory.md",
});

/** Voice — ElevenLabs voice integration (Voice phase). */
export const voiceSection: SectionModule = stubSection({
  id: "voice",
  title: "Voice & Audio",
  group: "computer",
  glyph: ICONS.voice,
  blurb:
    "Let Vesper speak its results aloud and listen for spoken requests. Wired through the UiModule Voice contract on run completion.",
  spec: "specs/voice-modalities.md",
});

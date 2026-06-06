import { ICONS } from "../shell/icons.ts";
import type { SectionModule } from "../shell/section.ts";
import { stubSection } from "./stub.ts";

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

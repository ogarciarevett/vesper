#!/usr/bin/env bun
/**
 * sync-ai-docs.ts — regenerate every per-tool agent artifact from the hand-edited
 * sources of truth under `.ai/`. You only ever edit `.ai/`; everything else is generated.
 *
 * SOURCES (hand-edited, the only files committed to git):
 *   .ai/context.md            project contract
 *   .ai/pipeline.md           GENERIC agent-skills lifecycle
 *   .ai/memory.md             LOCAL, gitignored per-dev log (referenced, never inlined)
 *   .ai/commands/<name>.md    canonical command defs (frontmatter `description` + body prompt)
 *   .ai/agents/<name>.md      canonical subagent defs (md + frontmatter)
 *   .ai/skills/<name>/SKILL.md canonical skills (+ bundled files)
 *   .ai/references/*.md        checklists referenced by path (NOT generated; cite as .ai/references/...)
 *
 * GENERATED (gitignored — materialized by this script; never hand-edit):
 *   Contract entry files:
 *     AGENTS.md, .ai/generated/rules.mdc  — INLINE full contract (canonical; plain-text readers)
 *     CLAUDE.md, GEMINI.md                — thin `@`-import stubs (Claude/Gemini resolve imports)
 *     .cursor/rules/00-context.mdc        — symlink → .ai/generated/rules.mdc
 *   Commands:  .claude/commands/*.md, .opencode/commands/*.md (copy) + .gemini/commands/*.toml (transform)
 *   Agents:    .claude/agents/*.md, .opencode/agents/*.md, .gemini/agents/*.md (copy)
 *   Skills:    .claude/skills/<n>/ (Claude + opencode read it) + .gemini/skills/<n>/ (Gemini)
 *
 * WHY GENERATE (not symlink): directory symlinks are not reliably discovered (opencode
 * glob bug; Claude undocumented), no tool exposes a path-override config, and commands
 * diverge in format (Markdown vs Gemini TOML). Generation sidesteps all of it.
 *
 * opencode also reads .ai/context.md + .ai/pipeline.md + .ai/memory.md directly (opencode.json).
 * `--all-inline` forces the contract stubs (CLAUDE/GEMINI) to inline too. Output is
 * deterministic (no timestamps) so the pre-commit `git diff` only fires on real changes.
 */
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const AI = join(ROOT, ".ai");
const GENERATED_DIR = join(AI, "generated");
const TEMPLATES = join(AI, "templates");
const MEMORY = join(AI, "memory.md");

const allInline = process.argv.includes("--all-inline");
const read = (p: string) => readFileSync(p, "utf8");

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function writeReal(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  // Drop a pre-existing symlink (e.g. an old CLAUDE.md → AGENTS.md) so we don't write through it.
  if (isSymlink(path)) rmSync(path);
  writeFileSync(path, content);
}

function ensureSymlink(linkPath: string, targetPath: string): void {
  mkdirSync(dirname(linkPath), { recursive: true });
  if (existsSync(linkPath) || isSymlink(linkPath)) rmSync(linkPath, { force: true });
  symlinkSync(relative(dirname(linkPath), targetPath), linkPath);
}

// ---------------------------------------------------------------- contract docs
// Seed the local, gitignored memory log from the committed template if absent.
if (!existsSync(MEMORY)) copyFileSync(join(AI, "memory.example.md"), MEMORY);

const banner = read(join(TEMPLATES, "banner.md")).trim();
const cursorHeader = read(join(TEMPLATES, "cursor.header.mdc")).trim();
const context = read(join(AI, "context.md")).trimEnd();
const pipeline = read(join(AI, "pipeline.md")).trimEnd();

const contractInline = `${context}\n\n${pipeline}`;
const contractImports = "@.ai/context.md\n\n@.ai/pipeline.md";
const memorySection = [
  "## Memory",
  "",
  "Shared working log: `.ai/memory.md` — LOCAL and gitignored (seed from",
  "`.ai/memory.example.md`; `bun run sync:ai` seeds it for you). It is not inlined here;",
  "tools that resolve imports pull it in, and opencode reads it directly:",
  "",
  "@.ai/memory.md",
].join("\n");

type DocTarget = {
  path: string;
  kind: "markdown" | "cursor";
  mode: "inline" | "imports";
};
const docTargets: DocTarget[] = [
  { path: join(ROOT, "AGENTS.md"), kind: "markdown", mode: "inline" },
  { path: join(GENERATED_DIR, "rules.mdc"), kind: "cursor", mode: "inline" },
  { path: join(ROOT, "CLAUDE.md"), kind: "markdown", mode: "imports" },
  { path: join(ROOT, "GEMINI.md"), kind: "markdown", mode: "imports" },
];

for (const t of docTargets) {
  const contract = t.mode === "imports" && !allInline ? contractImports : contractInline;
  const body = `${contract}\n\n${memorySection}`;
  const out =
    t.kind === "cursor" ? `${cursorHeader}\n\n${banner}\n\n${body}\n` : `${banner}\n\n${body}\n`;
  writeReal(t.path, out);
}
ensureSymlink(join(ROOT, ".cursor/rules/00-context.mdc"), join(GENERATED_DIR, "rules.mdc"));

// ---------------------------------------------------------------- per-tool assets
const COMMANDS_SRC = join(AI, "commands");
const AGENTS_SRC = join(AI, "agents");
const SKILLS_SRC = join(AI, "skills");

/** Markdown source basenames in a dir, excluding README.md. */
function mdNames(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .map((f) => f.slice(0, -3));
}

/** Pull `description` out of YAML frontmatter and return the markdown body. */
function splitFrontmatter(text: string): { description: string; body: string } {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { description: "", body: text.trim() };
  let description = "";
  for (const line of m[1].split("\n")) {
    const mm = line.match(/^description:\s*(.*)$/);
    if (mm) description = mm[1].trim().replace(/^["']|["']$/g, "");
  }
  return { description, body: m[2].trim() };
}

const tomlBasic = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const tomlMultiline = (s: string) =>
  `"""\n${s.replace(/\\/g, "\\\\").replace(/"""/g, '\\"\\"\\"')}\n"""`;

function copyDirFresh(src: string, dest: string): void {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true });
}

// Commands → Claude/opencode (copy) + Gemini (md → toml).
let commands = 0;
for (const name of mdNames(COMMANDS_SRC)) {
  const raw = read(join(COMMANDS_SRC, `${name}.md`));
  writeReal(join(ROOT, ".claude/commands", `${name}.md`), raw);
  writeReal(join(ROOT, ".opencode/commands", `${name}.md`), raw);
  const { description, body } = splitFrontmatter(raw);
  const toml = `description = ${tomlBasic(description || `${name} command`)}\nprompt = ${tomlMultiline(body)}\n`;
  writeReal(join(ROOT, ".gemini/commands", `${name}.toml`), toml);
  commands++;
}

// Agents → Claude/opencode/Gemini (copy; shared frontmatter, each tool ignores unknown keys).
let agents = 0;
for (const name of mdNames(AGENTS_SRC)) {
  const raw = read(join(AGENTS_SRC, `${name}.md`));
  writeReal(join(ROOT, ".claude/agents", `${name}.md`), raw);
  writeReal(join(ROOT, ".opencode/agents", `${name}.md`), raw);
  writeReal(join(ROOT, ".gemini/agents", `${name}.md`), raw);
  agents++;
}

// Skills → .claude/skills (Claude + opencode read it) + .gemini/skills (Gemini).
// (Not also .agents/skills, which opencode reads too — that would double-load for opencode.)
let skills = 0;
if (existsSync(SKILLS_SRC)) {
  for (const name of readdirSync(SKILLS_SRC)) {
    const src = join(SKILLS_SRC, name);
    if (!statSync(src).isDirectory()) continue;
    copyDirFresh(src, join(ROOT, ".claude/skills", name));
    copyDirFresh(src, join(ROOT, ".gemini/skills", name));
    skills++;
  }
}

// ---------------------------------------------------------------- summary
console.log(
  allInline
    ? "sync-ai-docs: regenerated (contract forced --all-inline)"
    : "sync-ai-docs: regenerated (AGENTS/cursor inline; CLAUDE/GEMINI @import stubs)",
);
console.log(
  `  docs    → AGENTS.md, CLAUDE.md, GEMINI.md, .ai/generated/rules.mdc (+ .cursor symlink)`,
);
console.log(`  commands→ ${commands} × {.claude, .opencode (md), .gemini (toml)}`);
console.log(`  agents  → ${agents} × {.claude, .opencode, .gemini}`);
console.log(`  skills  → ${skills} × {.claude/skills, .gemini/skills}`);

/**
 * The pipelines drop folder (specs/markdown-pipelines.md §3): every `*.md` in
 * `~/.vesper/pipelines/` IS a pipeline — the filename (minus .md) is its id, the
 * file content is the markdown document. Loaded at daemon boot and on
 * `vesper pipeline sync` / POST /api/pipelines/custom/sync. File wins; an
 * UNCHANGED file is skipped (no spurious revision bump); an invalid file is
 * reported per-file and registers nothing. Removing a file does NOT archive —
 * archiving stays an explicit action (Hard rule 4 posture).
 */

import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { isValidCustomPipelineId } from "@vesper/pipelines";
import type { CustomPipelinesSurface } from "@vesper/ui";

/** Outcome of one folder sweep. */
export interface PipelinesFolderSync {
  /** Ids saved this sweep (new or changed files). */
  readonly loaded: readonly string[];
  /** Ids whose file matched the stored doc (skipped, no revision bump). */
  readonly unchanged: readonly string[];
  readonly errors: readonly { readonly file: string; readonly errors: readonly string[] }[];
}

/** Sweep `dir` for `*.md` pipelines and upsert them through the shared surface. */
export async function syncPipelinesFolder(
  dir: string,
  surface: CustomPipelinesSurface,
): Promise<PipelinesFolderSync> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".md"));
  } catch {
    // No folder yet — nothing to load (the daemon creates it lazily).
    return { loaded: [], unchanged: [], errors: [] };
  }

  const loaded: string[] = [];
  const unchanged: string[] = [];
  const errors: { file: string; errors: readonly string[] }[] = [];

  for (const file of files.sort()) {
    const id = basename(file, ".md");
    if (!isValidCustomPipelineId(id)) {
      errors.push({ file, errors: [`filename "${id}" is not a valid pipeline id`] });
      continue;
    }
    let source: string;
    try {
      source = await readFile(join(dir, file), "utf8");
    } catch (err) {
      errors.push({ file, errors: [err instanceof Error ? err.message : String(err)] });
      continue;
    }
    const parsed = surface.parseMarkdown(source);
    if (!parsed.ok || parsed.doc === undefined) {
      errors.push({ file, errors: parsed.errors });
      continue;
    }
    const existing = surface.get(id);
    if (existing !== null && JSON.stringify(existing.doc) === JSON.stringify(parsed.doc)) {
      unchanged.push(id);
      continue;
    }
    const outcome = surface.save(id, parsed.doc);
    if (outcome.ok) loaded.push(id);
    else errors.push({ file, errors: outcome.errors });
  }

  return { loaded, unchanged, errors };
}

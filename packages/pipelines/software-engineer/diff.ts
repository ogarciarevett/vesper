/**
 * Unified diff parser for the software-engineer pipeline.
 *
 * Parses the output of `git diff` / `git diff --staged` (standard unified diff
 * with git extended headers) into a structured model suitable for a GitHub-PR-
 * quality renderer. Pure functions — no I/O, no process calls.
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type FileStatus = "added" | "deleted" | "modified" | "renamed";
export type DiffLineKind = "context" | "insert" | "delete";

export interface DiffLine {
  readonly kind: DiffLineKind;
  readonly content: string; // line text WITHOUT the leading +/-/space marker
  readonly oldLine: number | null; // line number in the old file (null for inserts)
  readonly newLine: number | null; // line number in the new file (null for deletes)
}

export interface DiffHunk {
  readonly header: string; // the raw "@@ -a,b +c,d @@ ..." line
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: readonly DiffLine[];
}

export interface FileDiff {
  readonly oldPath: string | null; // null for added files (/dev/null)
  readonly newPath: string | null; // null for deleted files (/dev/null)
  readonly path: string; // display path: newPath ?? oldPath
  readonly status: FileStatus;
  readonly additions: number; // count of insert lines in this file
  readonly deletions: number; // count of delete lines in this file
  readonly binary: boolean; // true for "Binary files ... differ" (no hunks)
  readonly hunks: readonly DiffHunk[];
}

export interface ParsedDiff {
  readonly files: readonly FileDiff[];
  readonly additions: number; // total across files
  readonly deletions: number; // total across files
  readonly fileCount: number;
}

// ---------------------------------------------------------------------------
// Internal mutable builder types
// ---------------------------------------------------------------------------

interface MutableHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

interface MutableFile {
  oldPath: string | null;
  newPath: string | null;
  status: FileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  hunks: MutableHunk[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip the `a/` or `b/` prefix that git prepends to paths in diff headers. */
function stripGitPrefix(p: string): string {
  if (p.startsWith("a/") || p.startsWith("b/")) return p.slice(2);
  return p;
}

/** Freeze a completed MutableFile into a sealed readonly FileDiff. */
function sealFile(m: MutableFile): FileDiff {
  return {
    oldPath: m.oldPath,
    newPath: m.newPath,
    path: m.newPath ?? m.oldPath ?? "",
    status: m.status,
    additions: m.additions,
    deletions: m.deletions,
    binary: m.binary,
    hunks: m.hunks.map(
      (h): DiffHunk => ({
        header: h.header,
        oldStart: h.oldStart,
        oldLines: h.oldLines,
        newStart: h.newStart,
        newLines: h.newLines,
        lines: h.lines,
      }),
    ),
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hunk header: `@@ -<old>[,<n>] +<new>[,<n>] @@[ optional section heading]` */
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The literal "no newline" meta-line that git emits after a file with no final newline. */
const NO_EOL_MARKER = "\\ No newline at end of file";

// ---------------------------------------------------------------------------
// parseUnifiedDiff
// ---------------------------------------------------------------------------

/**
 * Parse the output of `git diff` / `git diff --staged`.
 *
 * Empty or whitespace-only input returns an empty result with all counts zero.
 */
export function parseUnifiedDiff(raw: string): ParsedDiff {
  if (raw.trim() === "") {
    return { files: [], additions: 0, deletions: 0, fileCount: 0 };
  }

  // Normalise CRLF then split. A trailing newline produces one empty string at
  // the end which is harmless — it won't start with any recognised prefix.
  const lines = raw.replace(/\r\n/g, "\n").split("\n");

  const completed: FileDiff[] = [];
  let currentFile: MutableFile | null = null;
  let currentHunk: MutableHunk | null = null;
  let oldCounter = 0;
  let newCounter = 0;

  /** Push the in-progress hunk (if any) onto the current file's hunk list. */
  const flushHunk = (): void => {
    const hunk = currentHunk;
    const file = currentFile;
    if (hunk !== null && file !== null) {
      file.hunks.push(hunk);
      currentHunk = null;
    }
  };

  /** Seal the in-progress file (including any open hunk) and append to results. */
  const flushFile = (): void => {
    flushHunk();
    const file = currentFile;
    if (file !== null) {
      completed.push(sealFile(file));
      currentFile = null;
    }
  };

  for (const line of lines) {
    // ---------------------------------------------------------------------- //
    // File boundary — "diff --git a/<old> b/<new>"
    // ---------------------------------------------------------------------- //
    if (line.startsWith("diff --git ")) {
      flushFile();

      // Best-effort path extraction from the header line. Uses lastIndexOf so
      // simple filenames with spaces work; filenames containing " b/" are
      // unsupported here — --- / +++ lines override with the correct value.
      const tail = line.slice("diff --git ".length);
      const sepIdx = tail.lastIndexOf(" b/");
      currentFile = {
        oldPath: sepIdx >= 0 ? stripGitPrefix(tail.slice(0, sepIdx)) : null,
        newPath: sepIdx >= 0 ? tail.slice(sepIdx + 3) : null,
        status: "modified",
        additions: 0,
        deletions: 0,
        binary: false,
        hunks: [],
      };
      currentHunk = null;
      continue;
    }

    if (currentFile === null) continue;

    // ---------------------------------------------------------------------- //
    // Binary marker — can appear anywhere in the extended-header region
    // ---------------------------------------------------------------------- //
    if (line.startsWith("Binary files ")) {
      currentFile.binary = true;
      continue;
    }

    // ---------------------------------------------------------------------- //
    // Extended headers and path lines
    // Only meaningful before the first @@ hunk — guard with currentHunk === null
    // so that hunk-body lines like `-  --- foo` are not mistaken for headers.
    // ---------------------------------------------------------------------- //
    if (currentHunk === null) {
      if (line.startsWith("new file mode ")) {
        currentFile.status = "added";
        continue;
      }
      if (line.startsWith("deleted file mode ")) {
        currentFile.status = "deleted";
        continue;
      }
      if (line.startsWith("rename from ")) {
        currentFile.status = "renamed";
        currentFile.oldPath = line.slice("rename from ".length);
        continue;
      }
      if (line.startsWith("rename to ")) {
        currentFile.newPath = line.slice("rename to ".length);
        continue;
      }
      // "--- a/<path>" or "--- /dev/null"
      if (line.startsWith("--- ")) {
        const p = line.slice(4);
        currentFile.oldPath = p === "/dev/null" ? null : stripGitPrefix(p);
        continue;
      }
      // "+++ b/<path>" or "+++ /dev/null"
      if (line.startsWith("+++ ")) {
        const p = line.slice(4);
        currentFile.newPath = p === "/dev/null" ? null : stripGitPrefix(p);
        continue;
      }
    }

    // ---------------------------------------------------------------------- //
    // Hunk header — "@@ -<old>[,<n>] +<new>[,<n>] @@[ heading]"
    // ---------------------------------------------------------------------- //
    if (line.startsWith("@@ ")) {
      flushHunk();
      const m = HUNK_RE.exec(line);
      if (m === null) continue;
      // When the count is omitted it means 1 (standard unified diff convention).
      const oldStart = parseInt(m[1] ?? "1", 10);
      const oldLines = m[2] !== undefined ? parseInt(m[2], 10) : 1;
      const newStart = parseInt(m[3] ?? "1", 10);
      const newLines = m[4] !== undefined ? parseInt(m[4], 10) : 1;
      currentHunk = { header: line, oldStart, oldLines, newStart, newLines, lines: [] };
      oldCounter = oldStart;
      newCounter = newStart;
      continue;
    }

    // Not in a hunk — skip other extended-header noise (index lines, etc.)
    if (currentHunk === null) continue;

    // ---------------------------------------------------------------------- //
    // Hunk body
    // ---------------------------------------------------------------------- //

    // Skip the "no newline at end of file" meta-line — do not emit a DiffLine
    // and do not advance the line counters.
    if (line === NO_EOL_MARKER) continue;

    const marker: string | undefined = line[0];
    if (marker === undefined) continue; // empty line — skip

    const content = line.slice(1);

    if (marker === " ") {
      // Context line — advances both counters.
      currentHunk.lines.push({
        kind: "context",
        content,
        oldLine: oldCounter,
        newLine: newCounter,
      });
      oldCounter++;
      newCounter++;
    } else if (marker === "+") {
      // Inserted line — oldLine is null; only the new-file counter advances.
      currentHunk.lines.push({
        kind: "insert",
        content,
        oldLine: null,
        newLine: newCounter,
      });
      currentFile.additions++;
      newCounter++;
    } else if (marker === "-") {
      // Deleted line — newLine is null; only the old-file counter advances.
      currentHunk.lines.push({
        kind: "delete",
        content,
        oldLine: oldCounter,
        newLine: null,
      });
      currentFile.deletions++;
      oldCounter++;
    }
    // Any other leading character (malformed diff output) is silently ignored.
  }

  flushFile();

  const totalAdditions = completed.reduce((sum, f) => sum + f.additions, 0);
  const totalDeletions = completed.reduce((sum, f) => sum + f.deletions, 0);

  return {
    files: completed,
    additions: totalAdditions,
    deletions: totalDeletions,
    fileCount: completed.length,
  };
}

// ---------------------------------------------------------------------------
// contentHash
// ---------------------------------------------------------------------------

/**
 * Stable hex SHA-256 over the input bytes.
 *
 * Used to bind an approval to exactly the bytes the approver saw — if the diff
 * changes, the hash changes and any prior approval is invalidated.
 */
export function contentHash(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

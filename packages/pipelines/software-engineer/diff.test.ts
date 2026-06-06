/**
 * Tests for parseUnifiedDiff and contentHash (diff.ts).
 *
 * All fixtures are realistic template-literal git diff strings.
 * Line-number bookkeeping is verified explicitly in the first describe block.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { contentHash, parseUnifiedDiff } from "./diff.ts";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/** Return the first FileDiff in a parsed result, or throw if none. */
function firstFile(raw: string) {
  const parsed = parseUnifiedDiff(raw);
  const f = parsed.files[0];
  if (f === undefined) throw new Error("expected at least one FileDiff");
  return f;
}

// ===========================================================================
// Empty input
// ===========================================================================

describe("parseUnifiedDiff — empty input", () => {
  test("empty string returns zero-count result", () => {
    expect(parseUnifiedDiff("")).toEqual({
      files: [],
      additions: 0,
      deletions: 0,
      fileCount: 0,
    });
  });

  test("whitespace-only string returns zero-count result", () => {
    expect(parseUnifiedDiff("   \n  \n")).toEqual({
      files: [],
      additions: 0,
      deletions: 0,
      fileCount: 0,
    });
  });
});

// ===========================================================================
// Modified file — single hunk (line-number bookkeeping)
// ===========================================================================

describe("parseUnifiedDiff — modified file, single hunk", () => {
  // @@ -1,4 +1,5 @@
  //  context1   → old=1,  new=1
  // -deleted2   → old=2,  new=null
  // +inserted2  → old=null, new=2
  // +inserted3  → old=null, new=3
  //  context3   → old=3,  new=4
  //  context4   → old=4,  new=5
  const RAW = `\
diff --git a/src/foo.ts b/src/foo.ts
index abc1234..def5678 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,4 +1,5 @@
 context1
-deleted2
+inserted2
+inserted3
 context3
 context4
`;

  test("file metadata", () => {
    const f = firstFile(RAW);
    expect(f.oldPath).toBe("src/foo.ts");
    expect(f.newPath).toBe("src/foo.ts");
    expect(f.path).toBe("src/foo.ts");
    expect(f.status).toBe("modified");
    expect(f.binary).toBe(false);
    expect(f.additions).toBe(2);
    expect(f.deletions).toBe(1);
  });

  test("hunk header fields", () => {
    const h = firstFile(RAW).hunks[0];
    if (h === undefined) throw new Error("expected hunk");
    expect(h.oldStart).toBe(1);
    expect(h.oldLines).toBe(4);
    expect(h.newStart).toBe(1);
    expect(h.newLines).toBe(5);
    expect(h.header).toContain("@@ -1,4 +1,5 @@");
  });

  test("exact oldLine/newLine bookkeeping", () => {
    const lines = firstFile(RAW).hunks[0]?.lines;
    if (lines === undefined) throw new Error("expected lines");
    expect(lines).toHaveLength(6);

    // context advances both counters
    expect(lines[0]).toEqual({ kind: "context", content: "context1", oldLine: 1, newLine: 1 });
    // delete advances oldLine only; newLine is null
    expect(lines[1]).toEqual({ kind: "delete", content: "deleted2", oldLine: 2, newLine: null });
    // insert: oldLine null, newLine increments from its own counter
    expect(lines[2]).toEqual({ kind: "insert", content: "inserted2", oldLine: null, newLine: 2 });
    // second consecutive insert
    expect(lines[3]).toEqual({ kind: "insert", content: "inserted3", oldLine: null, newLine: 3 });
    // context: old counter resumed at 3 (line 2 was consumed by the delete)
    expect(lines[4]).toEqual({ kind: "context", content: "context3", oldLine: 3, newLine: 4 });
    expect(lines[5]).toEqual({ kind: "context", content: "context4", oldLine: 4, newLine: 5 });
  });
});

// ===========================================================================
// Modified file — multiple hunks
// ===========================================================================

describe("parseUnifiedDiff — multi-hunk file", () => {
  const RAW = `\
diff --git a/src/bar.ts b/src/bar.ts
index abc1234..def5678 100644
--- a/src/bar.ts
+++ b/src/bar.ts
@@ -1,3 +1,3 @@
 line1
-old2
+new2
 line3
@@ -10,3 +10,3 @@
 line10
-old11
+new11
 line12
`;

  test("two hunks are parsed", () => {
    expect(firstFile(RAW).hunks).toHaveLength(2);
  });

  test("first hunk: correct lines and counters", () => {
    const lines = firstFile(RAW).hunks[0]?.lines;
    if (lines === undefined) throw new Error("expected lines");
    expect(lines[0]).toEqual({ kind: "context", content: "line1", oldLine: 1, newLine: 1 });
    expect(lines[1]).toEqual({ kind: "delete", content: "old2", oldLine: 2, newLine: null });
    expect(lines[2]).toEqual({ kind: "insert", content: "new2", oldLine: null, newLine: 2 });
    expect(lines[3]).toEqual({ kind: "context", content: "line3", oldLine: 3, newLine: 3 });
  });

  test("second hunk: counters reset from its own oldStart/newStart", () => {
    const lines = firstFile(RAW).hunks[1]?.lines;
    if (lines === undefined) throw new Error("expected lines");
    expect(lines[0]).toEqual({ kind: "context", content: "line10", oldLine: 10, newLine: 10 });
    expect(lines[1]).toEqual({ kind: "delete", content: "old11", oldLine: 11, newLine: null });
    expect(lines[2]).toEqual({ kind: "insert", content: "new11", oldLine: null, newLine: 11 });
    expect(lines[3]).toEqual({ kind: "context", content: "line12", oldLine: 12, newLine: 12 });
  });

  test("additions and deletions are counted across both hunks", () => {
    const f = firstFile(RAW);
    expect(f.additions).toBe(2);
    expect(f.deletions).toBe(2);
  });
});

// ===========================================================================
// Added file
// ===========================================================================

describe("parseUnifiedDiff — added file", () => {
  const RAW = `\
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,3 @@
+line1
+line2
+line3
`;

  test("status 'added', oldPath null, path from newPath", () => {
    const f = firstFile(RAW);
    expect(f.status).toBe("added");
    expect(f.oldPath).toBeNull();
    expect(f.newPath).toBe("src/new.ts");
    expect(f.path).toBe("src/new.ts");
  });

  test("all lines are inserts with sequential newLine numbers", () => {
    const lines = firstFile(RAW).hunks[0]?.lines;
    if (lines === undefined) throw new Error("expected lines");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toEqual({ kind: "insert", content: "line1", oldLine: null, newLine: 1 });
    expect(lines[1]).toEqual({ kind: "insert", content: "line2", oldLine: null, newLine: 2 });
    expect(lines[2]).toEqual({ kind: "insert", content: "line3", oldLine: null, newLine: 3 });
  });

  test("additions=3, deletions=0", () => {
    const f = firstFile(RAW);
    expect(f.additions).toBe(3);
    expect(f.deletions).toBe(0);
  });
});

// ===========================================================================
// Deleted file
// ===========================================================================

describe("parseUnifiedDiff — deleted file", () => {
  const RAW = `\
diff --git a/src/old.ts b/src/old.ts
deleted file mode 100644
index abc1234..0000000
--- a/src/old.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-line1
-line2
-line3
`;

  test("status 'deleted', newPath null, path from oldPath", () => {
    const f = firstFile(RAW);
    expect(f.status).toBe("deleted");
    expect(f.newPath).toBeNull();
    expect(f.oldPath).toBe("src/old.ts");
    expect(f.path).toBe("src/old.ts");
  });

  test("all lines are deletes with sequential oldLine numbers", () => {
    const lines = firstFile(RAW).hunks[0]?.lines;
    if (lines === undefined) throw new Error("expected lines");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toEqual({ kind: "delete", content: "line1", oldLine: 1, newLine: null });
    expect(lines[1]).toEqual({ kind: "delete", content: "line2", oldLine: 2, newLine: null });
    expect(lines[2]).toEqual({ kind: "delete", content: "line3", oldLine: 3, newLine: null });
  });

  test("additions=0, deletions=3", () => {
    const f = firstFile(RAW);
    expect(f.additions).toBe(0);
    expect(f.deletions).toBe(3);
  });
});

// ===========================================================================
// Renamed file (100% similarity — no hunks)
// ===========================================================================

describe("parseUnifiedDiff — renamed file", () => {
  const RAW = `\
diff --git a/src/old-name.ts b/src/new-name.ts
similarity index 100%
rename from src/old-name.ts
rename to src/new-name.ts
`;

  test("status 'renamed', oldPath and newPath reflect the rename", () => {
    const f = firstFile(RAW);
    expect(f.status).toBe("renamed");
    expect(f.oldPath).toBe("src/old-name.ts");
    expect(f.newPath).toBe("src/new-name.ts");
    expect(f.path).toBe("src/new-name.ts");
  });

  test("no hunks, no add/del, not binary", () => {
    const f = firstFile(RAW);
    expect(f.hunks).toHaveLength(0);
    expect(f.additions).toBe(0);
    expect(f.deletions).toBe(0);
    expect(f.binary).toBe(false);
  });
});

// ===========================================================================
// Binary file
// ===========================================================================

describe("parseUnifiedDiff — binary file", () => {
  const RAW = `\
diff --git a/assets/image.png b/assets/image.png
index abc1234..def5678 100644
Binary files a/assets/image.png and b/assets/image.png differ
`;

  test("binary=true, no hunks, no add/del", () => {
    const f = firstFile(RAW);
    expect(f.binary).toBe(true);
    expect(f.hunks).toHaveLength(0);
    expect(f.additions).toBe(0);
    expect(f.deletions).toBe(0);
  });

  test("paths extracted from the diff --git header line", () => {
    const f = firstFile(RAW);
    expect(f.oldPath).toBe("assets/image.png");
    expect(f.newPath).toBe("assets/image.png");
    expect(f.path).toBe("assets/image.png");
  });
});

// ===========================================================================
// Hunk header without explicit line counts (@@ -1 +1 @@)
// ===========================================================================

describe("parseUnifiedDiff — hunk header without explicit counts", () => {
  const RAW = `\
diff --git a/src/single.ts b/src/single.ts
index abc1234..def5678 100644
--- a/src/single.ts
+++ b/src/single.ts
@@ -1 +1 @@
-old line
+new line
`;

  test("omitted count defaults to 1 for both sides", () => {
    const h = firstFile(RAW).hunks[0];
    if (h === undefined) throw new Error("expected hunk");
    expect(h.oldStart).toBe(1);
    expect(h.oldLines).toBe(1);
    expect(h.newStart).toBe(1);
    expect(h.newLines).toBe(1);
  });

  test("lines parsed correctly", () => {
    const lines = firstFile(RAW).hunks[0]?.lines;
    if (lines === undefined) throw new Error("expected lines");
    expect(lines[0]).toEqual({ kind: "delete", content: "old line", oldLine: 1, newLine: null });
    expect(lines[1]).toEqual({ kind: "insert", content: "new line", oldLine: null, newLine: 1 });
  });
});

// ===========================================================================
// Multiple files in one diff
// ===========================================================================

describe("parseUnifiedDiff — multiple files", () => {
  // File a: +2 -1  File b: +0 -1  Total: +2 -2
  const RAW = `\
diff --git a/src/a.ts b/src/a.ts
index abc1234..def5678 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
 unchanged
-removed
+added1
+added2
diff --git a/src/b.ts b/src/b.ts
index 111aaaa..222bbbb 100644
--- a/src/b.ts
+++ b/src/b.ts
@@ -5,3 +5,2 @@
 ctx5
-del6
 ctx7
`;

  test("fileCount is 2", () => {
    expect(parseUnifiedDiff(RAW).fileCount).toBe(2);
  });

  test("per-file add/del counts", () => {
    const { files } = parseUnifiedDiff(RAW);
    expect(files[0]?.additions).toBe(2);
    expect(files[0]?.deletions).toBe(1);
    expect(files[1]?.additions).toBe(0);
    expect(files[1]?.deletions).toBe(1);
  });

  test("total additions and deletions are sums across all files", () => {
    const result = parseUnifiedDiff(RAW);
    expect(result.additions).toBe(2);
    expect(result.deletions).toBe(2);
  });

  test("paths are correct for both files", () => {
    const { files } = parseUnifiedDiff(RAW);
    expect(files[0]?.path).toBe("src/a.ts");
    expect(files[1]?.path).toBe("src/b.ts");
  });

  test("second file lines are parsed independently from first", () => {
    const { files } = parseUnifiedDiff(RAW);
    const lines = files[1]?.hunks[0]?.lines;
    if (lines === undefined) throw new Error("expected lines");
    // @@ -5,3 +5,2 @@
    expect(lines[0]).toEqual({ kind: "context", content: "ctx5", oldLine: 5, newLine: 5 });
    expect(lines[1]).toEqual({ kind: "delete", content: "del6", oldLine: 6, newLine: null });
    expect(lines[2]).toEqual({ kind: "context", content: "ctx7", oldLine: 7, newLine: 6 });
  });
});

// ===========================================================================
// "\ No newline at end of file" marker
// ===========================================================================

describe("parseUnifiedDiff — no-newline marker", () => {
  // The `\\` escape in a template literal produces a single `\` in the string,
  // matching the literal `\ No newline at end of file` line that git emits.
  const RAW = `\
diff --git a/src/noeol.ts b/src/noeol.ts
index abc1234..def5678 100644
--- a/src/noeol.ts
+++ b/src/noeol.ts
@@ -1,2 +1,2 @@
-old line
\\ No newline at end of file
+new line
\\ No newline at end of file
`;

  test("no-newline marker lines are not emitted as DiffLines", () => {
    const lines = firstFile(RAW).hunks[0]?.lines;
    if (lines === undefined) throw new Error("expected lines");
    // Only the delete and insert; the two marker lines are skipped.
    expect(lines).toHaveLength(2);
    expect(lines[0]?.kind).toBe("delete");
    expect(lines[1]?.kind).toBe("insert");
  });

  test("no-newline markers do not advance line counters", () => {
    const lines = firstFile(RAW).hunks[0]?.lines;
    if (lines === undefined) throw new Error("expected lines");
    expect(lines[0]).toEqual({ kind: "delete", content: "old line", oldLine: 1, newLine: null });
    expect(lines[1]).toEqual({ kind: "insert", content: "new line", oldLine: null, newLine: 1 });
  });
});

// ===========================================================================
// contentHash
// ===========================================================================

describe("contentHash", () => {
  test("is deterministic for the same input", () => {
    expect(contentHash("hello, world")).toBe(contentHash("hello, world"));
  });

  test("differs when input changes", () => {
    expect(contentHash("hello")).not.toBe(contentHash("world"));
  });

  test("is a 64-character lowercase hex string (SHA-256)", () => {
    expect(contentHash("vesper diff test")).toMatch(/^[0-9a-f]{64}$/);
  });

  test("matches the SHA-256 produced by node:crypto for the same input", () => {
    const input = "vesper diff content hash";
    const expected = createHash("sha256").update(input).digest("hex");
    expect(contentHash(input)).toBe(expected);
  });
});

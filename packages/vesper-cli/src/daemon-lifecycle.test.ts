import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readPidFile,
  removePidFile,
  resolveDaemonState,
  writePidFile,
} from "./daemon-lifecycle.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "vesper-pid-"));
}

describe("PID file round-trip", () => {
  test("writes then reads back the pid", () => {
    const dir = tempDir();
    try {
      const path = join(dir, "vesperd.pid");
      writePidFile(path, 4321);
      expect(readPidFile(path)).toBe(4321);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing file reads as null", () => {
    expect(readPidFile(join(tempDir(), "absent.pid"))).toBeNull();
  });

  test("malformed contents read as null", () => {
    const dir = tempDir();
    try {
      const path = join(dir, "vesperd.pid");
      writePidFile(path, 0); // 0 is not a valid pid
      // overwrite with junk
      Bun.write(path, "not-a-number\n");
      expect(readPidFile(path)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("removePidFile is idempotent", () => {
    const dir = tempDir();
    try {
      const path = join(dir, "vesperd.pid");
      writePidFile(path, 10);
      removePidFile(path);
      removePidFile(path); // no throw the second time
      expect(readPidFile(path)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveDaemonState", () => {
  const dir = tempDir();
  const path = join(dir, "vesperd.pid");

  test("no pidfile -> stopped", () => {
    expect(resolveDaemonState(join(dir, "none.pid"))).toEqual({ status: "stopped" });
  });

  test("pidfile + live process -> running with since", () => {
    writePidFile(path, 999);
    const state = resolveDaemonState(
      path,
      () => true,
      () => 1_700_000_000_000,
    );
    expect(state).toEqual({ status: "running", pid: 999, since: 1_700_000_000_000 });
  });

  test("pidfile + dead process -> stale", () => {
    writePidFile(path, 999);
    expect(resolveDaemonState(path, () => false)).toEqual({ status: "stale", pid: 999 });
    rmSync(dir, { recursive: true, force: true });
  });
});

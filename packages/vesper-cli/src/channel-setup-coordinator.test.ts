import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type SetupUpdate } from "@vesper/core";
import { type AgenticComplete, ChannelSetupCoordinator } from "./channel-setup-coordinator.ts";

const VALID_TG = "123456789:AAH9xVbq1Yc-Z_kPretendTokenABCDEFGHIJ012";

/** Drain a setup session into an array of updates. */
async function drain(
  coord: ChannelSetupCoordinator,
  id: string,
): Promise<{ updates: SetupUpdate[]; statuses: string[] }> {
  const updates: SetupUpdate[] = [];
  for await (const u of coord.setup(id).updates()) updates.push(u);
  return { updates, statuses: updates.map((u) => u.status) };
}

const completeReturning =
  (text: string): AgenticComplete =>
  async () => ({ text });

describe("ChannelSetupCoordinator.setup", () => {
  test("mints + persists a token on a clean agentic result, ending 'configured'", async () => {
    const persisted: Array<{ id: string; token: string }> = [];
    const coord = new ChannelSetupCoordinator({
      complete: completeReturning(`All done!\n${VALID_TG}`),
      persistToken: async (id, token) => {
        persisted.push({ id, token });
      },
    });

    const { statuses, updates } = await drain(coord, "telegram");
    expect(statuses).toEqual(["working", "working", "configured"]);
    expect(persisted).toEqual([{ id: "telegram", token: VALID_TG }]);
    // The agentic prompt is what reaches the CLI, never the token in any update text.
    expect(JSON.stringify(updates)).not.toContain(VALID_TG);
  });

  test("NEED_USER_LOGIN -> graceful awaiting_user, NO persist", async () => {
    const persisted: string[] = [];
    const coord = new ChannelSetupCoordinator({
      complete: completeReturning("NEED_USER_LOGIN"),
      persistToken: async (id) => {
        persisted.push(id);
      },
    });
    const { statuses, updates } = await drain(coord, "telegram");
    expect(statuses).toEqual(["working", "awaiting_user"]);
    expect(persisted).toHaveLength(0);
    expect(updates.at(-1)).toMatchObject({ status: "awaiting_user" });
  });

  test("an unparseable result -> awaiting_user, NO persist (strict token parse)", async () => {
    const persisted: string[] = [];
    const coord = new ChannelSetupCoordinator({
      complete: completeReturning("I created the app but could not find the token."),
      persistToken: async (id) => {
        persisted.push(id);
      },
    });
    const { statuses } = await drain(coord, "telegram");
    expect(statuses).toEqual(["working", "awaiting_user"]);
    expect(persisted).toHaveLength(0);
  });

  test("a CLI error -> awaiting_user (best-effort, never a dead-end)", async () => {
    const coord = new ChannelSetupCoordinator({
      complete: async () => {
        throw new Error("claude: timed out after 300000ms");
      },
      persistToken: async () => {},
    });
    const { statuses, updates } = await drain(coord, "telegram");
    expect(statuses).toEqual(["working", "awaiting_user"]);
    expect((updates.at(-1) as { reason: string }).reason).toContain("could not run");
  });

  test("a persist failure surfaces as a terminal error", async () => {
    const coord = new ChannelSetupCoordinator({
      complete: completeReturning(VALID_TG),
      persistToken: async () => {
        throw new Error("keychain denied");
      },
    });
    const { statuses, updates } = await drain(coord, "telegram");
    expect(statuses).toEqual(["working", "working", "error"]);
    expect((updates.at(-1) as { reason: string }).reason).toContain("keychain denied");
  });

  test("a channel with no automated setup yields a single error", async () => {
    const coord = new ChannelSetupCoordinator({
      complete: completeReturning(VALID_TG),
      persistToken: async () => {},
    });
    const { statuses } = await drain(coord, "signal");
    expect(statuses).toEqual(["error"]);
  });

  test("audits outcome only — the token NEVER lands in an audit row", async () => {
    const dir = join(tmpdir(), `vesper-setup-${crypto.randomUUID()}`);
    openStore(dir + ".db").close();
    const store = openStore(dir + ".db");
    try {
      const coord = new ChannelSetupCoordinator({
        complete: completeReturning(VALID_TG),
        persistToken: async () => {},
        store,
      });
      await drain(coord, "telegram");
      const events = store.listEvents({ limit: 20 }).filter((e) => e.source === "connections");
      const kinds = events.map((e) => e.kind);
      expect(kinds).toContain("connection_setup_started");
      expect(kinds).toContain("connection_setup_succeeded");
      expect(JSON.stringify(events)).not.toContain(VALID_TG);
    } finally {
      store.close();
      rmSync(dir + ".db", { force: true });
      rmSync(dir + ".db-shm", { force: true });
      rmSync(dir + ".db-wal", { force: true });
    }
  });
});

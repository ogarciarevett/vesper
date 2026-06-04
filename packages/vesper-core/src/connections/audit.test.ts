import { describe, expect, test } from "bun:test";
import type { Store } from "../storage/index.ts";
import { openStore } from "../storage/index.ts";
import { recordConnectionEvent, stripSensitive } from "./audit.ts";

function memStore(): Store {
  const store = openStore(":memory:");
  store.migrate();
  return store;
}

describe("stripSensitive", () => {
  test("drops token/value/secret/message-body fields, keeps wiring", () => {
    const cleaned = stripSensitive({
      channel: "telegram",
      vaultKey: "telegram_bot_token",
      token: "123:SECRET",
      value: "also-secret",
      text: "a private message body",
      message: "another body",
      outcome: "ok",
    });
    expect(cleaned).toEqual({
      channel: "telegram",
      vaultKey: "telegram_bot_token",
      outcome: "ok",
    });
    expect(cleaned.token).toBeUndefined();
    expect(cleaned.text).toBeUndefined();
  });
});

describe("recordConnectionEvent", () => {
  test("appends a source:connections event with no secret in the payload", () => {
    const store = memStore();
    recordConnectionEvent(store, "connection_connected", {
      channel: "telegram",
      vaultKey: "telegram_bot_token",
      token: "123:SECRET",
    });
    const events = store.listEvents({ source: "connections" });
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("connection_connected");
    expect(events[0]?.payload).toEqual({ channel: "telegram", vaultKey: "telegram_bot_token" });
    // The serialized row must not contain the secret anywhere.
    expect(JSON.stringify(events[0])).not.toContain("123:SECRET");
    store.close();
  });

  test("records mcp_enabled / mcp_disabled kinds", () => {
    const store = memStore();
    recordConnectionEvent(store, "mcp_enabled", { mcp: "linear" });
    recordConnectionEvent(store, "mcp_disabled", { mcp: "linear" });
    const kinds = store.listEvents({ source: "connections" }).map((e) => e.kind);
    expect(kinds).toEqual(["mcp_enabled", "mcp_disabled"]);
    store.close();
  });
});

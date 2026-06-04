import { describe, expect, test } from "bun:test";
import type { Capability } from "../capabilities/index.ts";
import { CapabilityError } from "../capabilities/index.ts";
import { ConnectionError } from "./errors.ts";
import { allowlistedFetch, type FetchFn } from "./fetch.ts";

const GRANTED: readonly Capability[] = ["NETWORK_FETCH"];

/** A fetch spy that records every URL it is asked to fetch. */
function spyFetch(): { fn: FetchFn; calls: string[] } {
  const calls: string[] = [];
  const fn: FetchFn = async (input) => {
    calls.push(input);
    return new Response("{}", { headers: { "content-type": "application/json" } });
  };
  return { fn, calls };
}

describe("allowlistedFetch", () => {
  test("fetches a host in the allowlist", async () => {
    const { fn, calls } = spyFetch();
    const res = await allowlistedFetch({
      url: "https://api.telegram.org/bot123/getMe",
      allowedHosts: ["api.telegram.org"],
      granted: GRANTED,
      fetchFn: fn,
    });
    expect(res.status).toBe(200);
    expect(calls).toEqual(["https://api.telegram.org/bot123/getMe"]);
  });

  test("REFUSES a host not in the allowlist and makes NO request", async () => {
    const { fn, calls } = spyFetch();
    await expect(
      allowlistedFetch({
        url: "https://evil.example.com/steal",
        allowedHosts: ["api.telegram.org"],
        granted: GRANTED,
        fetchFn: fn,
      }),
    ).rejects.toMatchObject({
      name: "ConnectionError",
      reason: "host_not_allowed",
    });
    expect(calls).toEqual([]); // no request was made
  });

  test("refuses an LLM-provider host (Hard rule 12) — never widened past the allowlist", async () => {
    const { fn, calls } = spyFetch();
    await expect(
      allowlistedFetch({
        url: "https://api.anthropic.com/v1/messages",
        allowedHosts: ["api.telegram.org"],
        granted: GRANTED,
        fetchFn: fn,
      }),
    ).rejects.toBeInstanceOf(ConnectionError);
    expect(calls).toEqual([]);
  });

  test("refuses a malformed URL with NO request", async () => {
    const { fn, calls } = spyFetch();
    await expect(
      allowlistedFetch({
        url: "not a url",
        allowedHosts: ["api.telegram.org"],
        granted: GRANTED,
        fetchFn: fn,
      }),
    ).rejects.toMatchObject({ reason: "host_not_allowed" });
    expect(calls).toEqual([]);
  });

  test("asserts NETWORK_FETCH before any network work", async () => {
    const { fn, calls } = spyFetch();
    await expect(
      allowlistedFetch({
        url: "https://api.telegram.org/bot123/getMe",
        allowedHosts: ["api.telegram.org"],
        granted: [], // NETWORK_FETCH not granted
        fetchFn: fn,
      }),
    ).rejects.toBeInstanceOf(CapabilityError);
    expect(calls).toEqual([]);
  });

  test("host matching is case-insensitive", async () => {
    const { fn, calls } = spyFetch();
    await allowlistedFetch({
      url: "https://API.Telegram.ORG/bot123/getMe",
      allowedHosts: ["api.telegram.org"],
      granted: GRANTED,
      fetchFn: fn,
    });
    expect(calls).toHaveLength(1);
  });
});

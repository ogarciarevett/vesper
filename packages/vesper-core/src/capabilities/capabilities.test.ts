/**
 * Tests for the capabilities module (DEV-109).
 *
 * Covers:
 * - Capability type values and CAPABILITIES tuple
 * - isCapability type-guard
 * - isGranted helper
 * - assertCapabilities — deny-by-default, partial deny, full grant
 * - CapabilityError shape
 */

import { describe, expect, test } from "bun:test";
import { VesperError } from "../errors.ts";
import { assertCapabilities, isGranted } from "./assert.ts";
import { CAPABILITIES, isCapability } from "./capability.ts";
import { CapabilityError } from "./errors.ts";

// ---------------------------------------------------------------------------
// CAPABILITIES tuple
// ---------------------------------------------------------------------------

describe("CAPABILITIES", () => {
  test("contains all 9 capability values", () => {
    expect(CAPABILITIES).toHaveLength(9);
    expect(CAPABILITIES).toContain("READ_VAULT");
    expect(CAPABILITIES).toContain("WRITE_VAULT");
    expect(CAPABILITIES).toContain("READ_STORAGE");
    expect(CAPABILITIES).toContain("WRITE_STORAGE");
    expect(CAPABILITIES).toContain("CLI_INVOKE");
    expect(CAPABILITIES).toContain("NETWORK_FETCH");
    expect(CAPABILITIES).toContain("FS_READ");
    expect(CAPABILITIES).toContain("FS_WRITE");
    expect(CAPABILITIES).toContain("SPAWN_SUBAGENT");
  });

  test("all values are unique", () => {
    const unique = new Set(CAPABILITIES);
    expect(unique.size).toBe(CAPABILITIES.length);
  });

  test("SPAWN_SUBAGENT is a recognised capability (deny-by-default: nothing grants it)", () => {
    expect(isCapability("SPAWN_SUBAGENT")).toBe(true);
    expect(CAPABILITIES).toContain("SPAWN_SUBAGENT");
  });
});

// ---------------------------------------------------------------------------
// isCapability
// ---------------------------------------------------------------------------

describe("isCapability", () => {
  test("returns true for all known capability values", () => {
    for (const cap of CAPABILITIES) {
      expect(isCapability(cap)).toBe(true);
    }
  });

  test("returns false for unknown strings", () => {
    expect(isCapability("UNKNOWN")).toBe(false);
    expect(isCapability("read_vault")).toBe(false); // wrong case
    expect(isCapability("")).toBe(false);
  });

  test("returns false for non-string values", () => {
    expect(isCapability(null)).toBe(false);
    expect(isCapability(undefined)).toBe(false);
    expect(isCapability(42)).toBe(false);
    expect(isCapability({})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isGranted
// ---------------------------------------------------------------------------

describe("isGranted", () => {
  test("returns true when all requested caps are granted", () => {
    expect(isGranted(["READ_VAULT", "FS_READ"], ["READ_VAULT", "FS_READ", "CLI_INVOKE"])).toBe(
      true,
    );
  });

  test("returns false when any requested cap is not granted", () => {
    expect(isGranted(["READ_VAULT", "WRITE_VAULT"], ["READ_VAULT"])).toBe(false);
  });

  test("returns true for empty requested list (no caps needed)", () => {
    expect(isGranted([], [])).toBe(true);
    expect(isGranted([], ["READ_VAULT"])).toBe(true);
  });

  test("deny-by-default: empty grants refuse any non-empty request", () => {
    expect(isGranted(["READ_VAULT"], [])).toBe(false);
    expect(isGranted(["FS_READ"], [])).toBe(false);
  });

  test("exact match of requested and granted returns true", () => {
    expect(isGranted(["CLI_INVOKE"], ["CLI_INVOKE"])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// assertCapabilities
// ---------------------------------------------------------------------------

describe("assertCapabilities", () => {
  test("does not throw when all requested caps are granted", () => {
    expect(() =>
      assertCapabilities(["READ_VAULT", "FS_READ"], ["READ_VAULT", "FS_READ", "WRITE_STORAGE"]),
    ).not.toThrow();
  });

  test("does not throw for empty requested list", () => {
    expect(() => assertCapabilities([], [])).not.toThrow();
    expect(() => assertCapabilities([], ["READ_VAULT"])).not.toThrow();
  });

  test("throws CapabilityError when a requested cap is not granted", () => {
    expect(() => assertCapabilities(["WRITE_VAULT"], ["READ_VAULT"])).toThrow(CapabilityError);
  });

  test("CapabilityError has code 'capability' and reason 'denied'", () => {
    try {
      assertCapabilities(["NETWORK_FETCH"], []);
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(CapabilityError);
      const err = e as CapabilityError;
      expect(err.code).toBe("capability");
      expect(err.reason).toBe("denied");
      expect(err.message).toContain("NETWORK_FETCH");
    }
  });

  test("error message lists ALL denied capabilities", () => {
    try {
      assertCapabilities(["FS_READ", "FS_WRITE", "NETWORK_FETCH"], ["FS_READ"]);
    } catch (e: unknown) {
      const err = e as CapabilityError;
      expect(err.message).toContain("FS_WRITE");
      expect(err.message).toContain("NETWORK_FETCH");
      expect(err.message).not.toContain("FS_READ"); // FS_READ was granted
    }
  });

  test("deny-by-default: empty grants refuse any non-empty request", () => {
    expect(() => assertCapabilities(["CLI_INVOKE"], [])).toThrow(CapabilityError);
  });
});

// ---------------------------------------------------------------------------
// CapabilityError shape
// ---------------------------------------------------------------------------

describe("CapabilityError", () => {
  test("extends VesperError and Error", () => {
    const err = new CapabilityError("denied", "test error");
    expect(err).toBeInstanceOf(CapabilityError);
    expect(err).toBeInstanceOf(VesperError);
    expect(err).toBeInstanceOf(Error);
  });

  test("has correct code, reason, message, and name", () => {
    const err = new CapabilityError("denied", "caps denied: FS_WRITE");
    expect(err.code).toBe("capability");
    expect(err.reason).toBe("denied");
    expect(err.message).toBe("caps denied: FS_WRITE");
    expect(err.name).toBe("CapabilityError");
  });

  test("accepts ErrorOptions (cause)", () => {
    const cause = new Error("inner");
    const err = new CapabilityError("denied", "outer", { cause });
    expect(err.cause).toBe(cause);
  });
});

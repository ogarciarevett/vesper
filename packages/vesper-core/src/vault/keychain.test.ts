import { describe, expect, test } from "bun:test";
import type { ProcessRunner, RunResult } from "../process/run.ts";
import { VaultError } from "./errors.ts";
import { KeychainVault } from "./keychain.ts";

function result(partial: Partial<RunResult>): RunResult {
  return { stdout: "", stderr: "", exitCode: 0, durationMs: 1, ...partial };
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

/** In-memory fake of `security ... -s vesper -a <acct> [-w <val>]`. */
function fakeSecurity(): ProcessRunner {
  const store = new Map<string, string>();
  return async (command, args) => {
    expect(command).toBe("security");
    const sub = args[0];
    const account = flagValue(args, "-a") ?? "";
    if (sub === "add-generic-password") {
      store.set(account, flagValue(args, "-w") ?? "");
      return result({});
    }
    if (sub === "find-generic-password") {
      const value = store.get(account);
      return value === undefined
        ? result({ exitCode: 44, stderr: "The specified item could not be found in the keychain." })
        : result({ stdout: `${value}\n` });
    }
    if (sub === "delete-generic-password") {
      if (!store.has(account)) {
        return result({ exitCode: 44, stderr: "could not be found" });
      }
      store.delete(account);
      return result({});
    }
    return result({ exitCode: 1, stderr: "unexpected security subcommand" });
  };
}

describe("KeychainVault", () => {
  test("set then get returns the stored value", async () => {
    const vault = new KeychainVault({ run: fakeSecurity() });
    await vault.set("gh-token", "secret-123");
    expect(await vault.get("gh-token")).toBe("secret-123");
  });

  test("delete then get rejects with not_found", async () => {
    const vault = new KeychainVault({ run: fakeSecurity() });
    await vault.set("k", "v");
    await vault.delete("k");
    await expect(vault.get("k")).rejects.toMatchObject({ reason: "not_found" });
  });

  test("get of a missing key rejects with VaultError(not_found)", async () => {
    const vault = new KeychainVault({ run: fakeSecurity() });
    const error = await vault.get("missing").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VaultError);
    expect((error as VaultError).reason).toBe("not_found");
  });

  test("list returns sorted keys, excluding the internal index, never values", async () => {
    const vault = new KeychainVault({ run: fakeSecurity() });
    await vault.set("b-key", "2");
    await vault.set("a-key", "1");
    expect(await vault.list()).toEqual(["a-key", "b-key"]);
  });

  test("authorization failure maps to permission_denied", async () => {
    const run: ProcessRunner = async () =>
      result({ exitCode: 51, stderr: "User interaction is not allowed; authorization denied" });
    const vault = new KeychainVault({ run });
    await expect(vault.get("k")).rejects.toMatchObject({ reason: "permission_denied" });
  });

  test("a missing security binary maps to keychain_unavailable", async () => {
    const run: ProcessRunner = async () => {
      throw new Error("ENOENT: security not found");
    };
    const vault = new KeychainVault({ run });
    await expect(vault.set("k", "v")).rejects.toMatchObject({ reason: "keychain_unavailable" });
  });
});

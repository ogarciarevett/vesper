import { type ProcessRunner, type RunResult, runProcess } from "../process/run.ts";
import { VaultError } from "./errors.ts";
import type { Vault } from "./types.ts";

const DEFAULT_SERVICE = "vesper";
/** Internal account holding the JSON array of stored keys (see {@link KeychainVault.list}). */
const INDEX_ACCOUNT = "__keys__";

export interface KeychainVaultOptions {
  /** Process seam; defaults to the real `runProcess`. Tests inject a fake here. */
  readonly run?: ProcessRunner;
  /** Keychain service namespace. Defaults to "vesper". */
  readonly service?: string;
}

/**
 * {@link Vault} backed by the macOS Keychain via the `security` CLI — no native
 * dependency. `security` has no "list accounts for a service" verb, so we keep a
 * small index entry (`__keys__`, a JSON array) in sync on every `set`/`delete`
 * and read it for `list`.
 */
export class KeychainVault implements Vault {
  readonly #run: ProcessRunner;
  readonly #service: string;

  constructor(options: KeychainVaultOptions = {}) {
    this.#run = options.run ?? runProcess;
    this.#service = options.service ?? DEFAULT_SERVICE;
  }

  async get(key: string): Promise<string> {
    const res = await this.#security([
      "find-generic-password",
      "-s",
      this.#service,
      "-a",
      key,
      "-w",
    ]);
    if (res.exitCode !== 0) throw this.#mapError(res, key);
    return stripTrailingNewline(res.stdout);
  }

  async set(key: string, value: string): Promise<void> {
    const res = await this.#security([
      "add-generic-password",
      "-U",
      "-s",
      this.#service,
      "-a",
      key,
      "-w",
      value,
    ]);
    if (res.exitCode !== 0) throw this.#mapError(res, key);
    await this.#indexAdd(key);
  }

  async delete(key: string): Promise<void> {
    const res = await this.#security(["delete-generic-password", "-s", this.#service, "-a", key]);
    if (res.exitCode !== 0) throw this.#mapError(res, key);
    await this.#indexRemove(key);
  }

  async list(): Promise<string[]> {
    const keys = await this.#indexRead();
    return keys.filter((k) => k !== INDEX_ACCOUNT).sort();
  }

  /** Run `security`, mapping a spawn failure (binary missing) to keychain_unavailable. */
  async #security(args: readonly string[]): Promise<RunResult> {
    try {
      return await this.#run("security", args);
    } catch (cause) {
      throw new VaultError("keychain_unavailable", "macOS `security` command is unavailable", {
        cause,
      });
    }
  }

  #mapError(res: RunResult, key: string): VaultError {
    const stderr = res.stderr.toLowerCase();
    if (res.exitCode === 44 || stderr.includes("could not be found")) {
      return new VaultError("not_found", `no vault entry for "${key}"`);
    }
    if (stderr.includes("authorization") || stderr.includes("denied")) {
      return new VaultError("permission_denied", `keychain denied access for "${key}"`);
    }
    return new VaultError(
      "keychain_unavailable",
      `security failed (exit ${res.exitCode})${res.stderr.trim() ? `: ${res.stderr.trim()}` : ""}`,
    );
  }

  async #indexRead(): Promise<string[]> {
    const res = await this.#security([
      "find-generic-password",
      "-s",
      this.#service,
      "-a",
      INDEX_ACCOUNT,
      "-w",
    ]);
    if (res.exitCode !== 0) return [];
    try {
      const parsed: unknown = JSON.parse(stripTrailingNewline(res.stdout));
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  }

  async #indexWrite(keys: readonly string[]): Promise<void> {
    const res = await this.#security([
      "add-generic-password",
      "-U",
      "-s",
      this.#service,
      "-a",
      INDEX_ACCOUNT,
      "-w",
      JSON.stringify(keys),
    ]);
    if (res.exitCode !== 0) throw this.#mapError(res, INDEX_ACCOUNT);
  }

  async #indexAdd(key: string): Promise<void> {
    const keys = await this.#indexRead();
    if (!keys.includes(key)) await this.#indexWrite([...keys, key]);
  }

  async #indexRemove(key: string): Promise<void> {
    const keys = await this.#indexRead();
    if (keys.includes(key)) await this.#indexWrite(keys.filter((k) => k !== key));
  }
}

function stripTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value.slice(0, -1) : value;
}

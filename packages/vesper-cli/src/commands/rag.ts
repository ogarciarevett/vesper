import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  backfill,
  KeychainVault,
  openRagIndex,
  openStore,
  type RagSourceDoc,
  type RagSourceKind,
  ragSearch,
  ragStatus,
  StorageError,
  type Store,
} from "@vesper/core";
import { type EmbeddingsProvider, loadConfig, saveConfig } from "../config.ts";
import type { Command, CommandGroup } from "../dispatch.ts";
import {
  defaultVaultKey,
  makeEmbedder,
  PROVIDER_DEFAULTS,
  RAG_CAPABILITIES,
  resolveEmbeddings,
} from "../embeddings.ts";
import { dbPath } from "../paths.ts";
import { cyan, dim, errorLine, formatKeyValues, green, line, table, yellow } from "../ui.ts";

/** The committed repo skills that backfill indexes alongside the store walk. */
const DEFAULT_SKILLS_DIR = ".ai/skills";

/** Default top-k for `vesper rag search`. */
const DEFAULT_K = 5;

function strFlag(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function intFlag(value: string | boolean | undefined, fallback: number): number {
  if (typeof value !== "string") return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Ask a yes/no question on the TTY. EOF/anything-but-yes => false. */
async function confirm(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(prompt)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } catch {
    return false;
  } finally {
    rl.close();
  }
}

/**
 * Read a secret (API key) WITHOUT taking it as a shell argument (which would leak into
 * shell history). A TTY is prompted; piped input is read from stdin. Mirrors `vesper vault set`.
 */
async function readSecret(label: string): Promise<string> {
  if (process.stdin.isTTY) {
    return (prompt(`${label}: `) ?? "").trim();
  }
  return (await Bun.stdin.text()).replace(/\n$/, "").trim();
}

/** Gather `.ai/skills/<name>/SKILL.md` bodies as RAG source docs (host-side; needs FS_READ). */
function gatherSkillDocs(skillsDir: string): RagSourceDoc[] {
  if (!existsSync(skillsDir)) return [];
  const docs: RagSourceDoc[] = [];
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(skillsDir, entry.name, "SKILL.md");
    if (!existsSync(path)) continue;
    try {
      const text = readFileSync(path, "utf8");
      if (text.trim().length > 0) docs.push({ sourceKind: "skill", sourceId: entry.name, text });
    } catch {
      // an unreadable skill file is skipped, never fatal.
    }
  }
  return docs;
}

/** The one-line "not enabled" guidance shown whenever no embedder is configured. */
function notEnabled(): void {
  line(dim("semantic memory is not enabled — run `vesper rag setup` to configure an embedder"));
}

/** Open the store + (optionally) the RAG index from config + vault. Caller closes the store. */
async function openIndex(): Promise<{ store: Store; index: ReturnType<typeof openRagIndex> }> {
  const config = await loadConfig();
  const vault = new KeychainVault();
  const store = openStore(dbPath());
  const embedder = await makeEmbedder(config, vault, RAG_CAPABILITIES);
  return { store, index: openRagIndex(store, embedder, RAG_CAPABILITIES) };
}

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------

const setupCommand: Command = {
  name: "setup",
  summary: "Configure the bring-your-own embeddings provider (and store its API key in the vault).",
  usage:
    "vesper rag setup [--provider ollama|openai|voyage] [--endpoint URL] [--model M] [--dimensions N] [--vault-key K]   # key via stdin/prompt",
  async run({ flags }) {
    const providerRaw = strFlag(flags.provider) ?? "ollama";
    if (providerRaw !== "ollama" && providerRaw !== "openai" && providerRaw !== "voyage") {
      throw new Error(`unknown provider "${providerRaw}" (expected ollama, openai, or voyage)`);
    }
    const provider: EmbeddingsProvider = providerRaw;
    const def = PROVIDER_DEFAULTS[provider];

    const endpoint = strFlag(flags.endpoint) ?? def.endpoint;
    const model = strFlag(flags.model) ?? def.model;
    const dimensions = intFlag(flags.dimensions, def.dimensions);
    const vaultKey = strFlag(flags["vault-key"]) ?? defaultVaultKey(provider);

    // Persist the API key for key-needing providers (openai/voyage). ollama needs none.
    if (def.needsKey) {
      const key = await readSecret(`API key for ${provider} (stored in the OS keychain)`);
      if (key.length === 0) {
        throw new Error(`${provider} needs an API key — pipe it via stdin or run interactively`);
      }
      await new KeychainVault().set(vaultKey, key);
      line(green(`stored API key in the vault as "${vaultKey}"`));
    }

    // Merge into the existing config so other blocks (cli, connections, ...) are preserved.
    const config = await loadConfig();
    await saveConfig({
      ...config,
      embeddings: {
        provider,
        ...(endpoint !== def.endpoint ? { endpoint } : {}),
        model,
        dimensions,
        ...(vaultKey !== defaultVaultKey(provider) ? { vaultKey } : {}),
      },
    });

    line(green("semantic memory configured."));
    line(
      formatKeyValues([
        ["provider", provider],
        ["endpoint", endpoint],
        ["model", model],
        ["dimensions", String(dimensions)],
        ["next", "run `vesper rag index` to build the index"],
      ]),
    );
    return 0;
  },
};

// ---------------------------------------------------------------------------
// index
// ---------------------------------------------------------------------------

const indexCommand: Command = {
  name: "index",
  summary: "Embed Vesper's history (events, runs, skills) into the semantic index.",
  usage: "vesper rag index [--rebuild] [--skills-dir <dir>] [--yes]",
  async run({ flags }) {
    const rebuild = flags.rebuild === true;
    const skillsDir = strFlag(flags["skills-dir"]) ?? DEFAULT_SKILLS_DIR;

    const { store, index } = await openIndex();
    try {
      if (index === null) {
        notEnabled();
        return 1;
      }

      const extraDocuments = gatherSkillDocs(skillsDir);
      const already = store.ragDocumentCount();
      line(
        `Indexing Vesper's history${rebuild ? yellow(" (rebuild — re-embeds everything)") : ""}.`,
      );
      line(
        dim(
          `${already} document(s) already indexed; each new document is one embedding call against your provider.`,
        ),
      );

      if (flags.yes !== true) {
        if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
          errorLine("non-interactive terminal — pass --yes to confirm the index run");
          return 1;
        }
        if (!(await confirm("proceed? [y/N] "))) {
          errorLine("aborted");
          return 1;
        }
      }

      const result = await backfill(index, { rebuild, extraDocuments });
      line(green("index updated."));
      line(
        formatKeyValues([
          ["indexed", String(result.indexed)],
          ["skipped", String(result.skipped)],
          ["total", String(result.total)],
        ]),
      );
      return 0;
    } finally {
      store.close();
    }
  },
};

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

const searchCommand: Command = {
  name: "search",
  summary: "Semantic search over Vesper's indexed history (debug view of the retrieval seam).",
  usage: "vesper rag search <query> [--k N] [--source event|run|run_event|skill]",
  async run({ positionals, flags }) {
    const query = positionals.join(" ").trim();
    if (query.length === 0) throw new Error("usage: vesper rag search <query>");
    const k = intFlag(flags.k, DEFAULT_K);
    const source = strFlag(flags.source) as RagSourceKind | undefined;

    const { store, index } = await openIndex();
    try {
      if (index === null) {
        notEnabled();
        return 1;
      }
      const hits = await ragSearch(
        index,
        query,
        k,
        source !== undefined ? { sourceKind: source } : {},
      );
      if (hits.length === 0) {
        line(dim("no matches"));
        return 0;
      }
      const rows = hits.map((hit) => [
        cyan(hit.sourceKind),
        // distance = 1 - cosine, so similarity = 1 - distance (higher is closer).
        (1 - hit.distance).toFixed(3),
        hit.text.replace(/\s+/g, " ").slice(0, 80),
      ]);
      line(table(["source", "score", "snippet"], rows));
      return 0;
    } catch (err) {
      if (err instanceof StorageError && err.reason === "rag_unavailable") {
        notEnabled();
        return 1;
      }
      throw err;
    } finally {
      store.close();
    }
  },
};

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

const statusCommand: Command = {
  name: "status",
  summary: "Show the embeddings provider, index size, and per-source breakdown.",
  usage: "vesper rag status [--probe]",
  async run({ flags }) {
    const config = await loadConfig();
    const resolved = resolveEmbeddings(config);
    const store = openStore(dbPath());
    try {
      const total = store.ragDocumentCount();

      if (resolved === null) {
        line(yellow("semantic memory: not enabled"));
        line(
          formatKeyValues([
            ["indexed", String(total)],
            ["next", "`vesper rag setup`"],
          ]),
        );
        return 0;
      }

      // Optional reachability probe: one tiny embed call (costs provider quota), opt-in via --probe.
      let reachable: boolean | undefined;
      if (flags.probe === true) {
        const embedder = await makeEmbedder(config, new KeychainVault(), RAG_CAPABILITIES);
        try {
          if (embedder === null) throw new Error("no embedder (missing API key?)");
          await embedder.embed(["ping"]);
          reachable = true;
        } catch {
          reachable = false;
        }
      }

      // Per-source breakdown for the active embedder.
      const counts = new Map<RagSourceKind, number>();
      for (const row of store.listRagVectors({ embedderId: resolved.id })) {
        counts.set(row.sourceKind, (counts.get(row.sourceKind) ?? 0) + 1);
      }
      const breakdown =
        counts.size === 0
          ? dim("(none for this model yet)")
          : [...counts.entries()].map(([kind, n]) => `${kind}=${n}`).join("  ");

      const status = ragStatus({
        configured: true,
        indexedDocuments: total,
        provider: resolved.provider,
        model: resolved.model,
        dimensions: resolved.dimensions,
        ...(reachable !== undefined ? { reachable } : {}),
      });

      line(
        status.available
          ? green("semantic memory: enabled")
          : yellow("semantic memory: configured"),
      );
      line(
        formatKeyValues([
          ["provider", resolved.provider],
          ["endpoint", resolved.endpoint],
          ["model", resolved.model],
          ["dimensions", String(resolved.dimensions)],
          [
            "reachable",
            reachable === undefined
              ? dim("not probed (use --probe)")
              : reachable
                ? green("yes")
                : yellow("no"),
          ],
          ["indexed", String(total)],
          ["by source", breakdown],
        ]),
      );
      return 0;
    } finally {
      store.close();
    }
  },
};

/** `vesper rag ...` — configure, build, and query semantic memory (specs/rag-memory.md). */
export const ragGroup: CommandGroup = {
  name: "rag",
  summary: "Configure and query semantic memory (bring-your-own embeddings).",
  subcommands: [setupCommand, indexCommand, searchCommand, statusCommand],
};

/**
 * `vesper pipeline` — author, inspect, run, improve, and archive user pipelines
 * from the terminal (specs/pipeline-editor.md). Drives EXACTLY the daemon routes
 * the Vesper World editor uses (`/api/pipelines/custom*`), so UI/CLI parity is
 * structural: anything that works here works in the UI, and vice versa.
 *
 * Privileged mutations (save/rm) ride the same out-of-band approval flow as the
 * UI: the daemon prints a single-use code on ITS terminal; the operator pastes
 * it here.
 */

import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Command, CommandGroup } from "../dispatch.ts";
import { uiPort } from "../paths.ts";
import { dim, errorLine, green, line, yellow } from "../ui.ts";

/** Plain-language capability lines (the CLI face of the editor's permission cards). */
const CAPABILITY_LABELS: Readonly<Record<string, string>> = {
  CLI_INVOKE: "talk to your AI helper (CLI completions)",
  WRITE_STORAGE: "record its runs in Vesper's local database",
  READ_STORAGE: "read your local Vesper data (memory, run history)",
  SPAWN_SUBAGENT: "start other pipelines as sub-agents",
  NETWORK_FETCH: "send and receive over the network",
  FS_READ: "read files on this computer",
  FS_WRITE: "write files on this computer",
  PROCESS_RUN: "run programs on this computer",
  READ_VAULT: "read secrets from your vault",
  WRITE_VAULT: "store secrets in your vault",
};

interface DocSummaryish {
  readonly id: string;
  readonly name: string;
  readonly revision: number;
  readonly tsUpdated: number;
  readonly capabilities: readonly string[];
}

interface DocDetailish extends DocSummaryish {
  readonly doc: Record<string, unknown>;
}

interface SaveOutcomeish {
  readonly ok: boolean;
  readonly capabilities: readonly string[];
  readonly errors: readonly string[];
}

function strFlag(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Probe the daemon and return its base URL, or null (with a printed hint). */
async function daemonBase(): Promise<string | null> {
  const base = `http://127.0.0.1:${uiPort()}`;
  try {
    await fetch(`${base}/api/status`);
    return base;
  } catch {
    errorLine("the Vesper daemon is not running — start it with `vesper daemon start`");
    return null;
  }
}

/** Ask one line on the TTY (empty string on EOF). */
async function ask(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(prompt)).trim();
  } catch {
    return "";
  } finally {
    rl.close();
  }
}

/**
 * Mint an approval code (printed on the DAEMON's terminal, never returned over
 * HTTP) and collect it from the operator. Null when unavailable/aborted.
 */
async function collectApproval(base: string): Promise<string | null> {
  const res = await fetch(`${base}/api/approval/request`, { method: "POST" });
  if (!res.ok) {
    errorLine("approval is not configured on the daemon — restart it and retry");
    return null;
  }
  line(dim("an approval code was just printed in the daemon terminal (`vesper daemon run`"));
  line(dim("foreground, or the launchd log for a background daemon)."));
  const code = await ask("approval code: ");
  return code.length > 0 ? code : null;
}

function printCapabilities(capabilities: readonly string[]): void {
  if (capabilities.length === 0) {
    line(dim("  (no capabilities)"));
    return;
  }
  for (const cap of capabilities) {
    line(`  - ${cap}  ${dim(CAPABILITY_LABELS[cap] ?? "")}`);
  }
}

function printErrors(errors: readonly string[]): void {
  for (const err of errors) errorLine(`  ${err}`);
}

/** Derive a kebab-case id from a doc name ("Morning Brief!" -> "morning-brief"). */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

const listCommand: Command = {
  name: "list",
  summary: "List every pipeline — built-ins and your saved ones.",
  usage: "vesper pipeline list",
  async run() {
    const base = await daemonBase();
    if (base === null) return 1;
    const custom = (await (await fetch(`${base}/api/pipelines/custom`)).json()) as DocSummaryish[];
    const all = (await (await fetch(`${base}/api/pipelines`)).json()) as Array<{
      id: string;
      kind: string;
      enabled: boolean;
      requiredCapabilities: readonly string[];
    }>;

    line("your pipelines:");
    if (custom.length === 0) {
      line(dim("  (none yet — create one with `vesper pipeline save <file.json>` or in the UI)"));
    }
    for (const row of custom) {
      line(
        `  ${row.id}  ${dim(`"${row.name}" rev ${row.revision} — ${row.capabilities.join(", ")}`)}`,
      );
    }
    line("");
    line("built-in pipelines:");
    for (const task of all.filter((t) => !t.id.startsWith("custom:"))) {
      line(
        `  ${task.id}  ${dim(`${task.kind}${task.enabled ? "" : " (disabled)"} — ${task.requiredCapabilities.join(", ") || "no capabilities"}`)}`,
      );
    }
    return 0;
  },
};

/** The slice of `GET /api/pipelines/:id/template` the built-in `show` prints. */
interface BuiltinTemplateish {
  readonly handlerId: string;
  readonly prompt: string;
  readonly prompts?: readonly { name: string; template: string }[];
  readonly config: { readonly requiredCapabilities: readonly string[] };
}

/** Print a built-in pipeline: capabilities + its read-only prompt catalog. */
async function showBuiltin(base: string, id: string): Promise<number> {
  const res = await fetch(`${base}/api/pipelines/${encodeURIComponent(id)}/template`);
  if (!res.ok) {
    errorLine(`unknown pipeline "${id}" (vesper pipeline list)`);
    return 1;
  }
  const template = (await res.json()) as BuiltinTemplateish;
  line(`${id}  ${dim(`(built-in, handler ${template.handlerId})`)}`);
  line("");
  line("what it can touch:");
  printCapabilities(template.config.requiredCapabilities);
  if (template.prompt.trim().length > 0) {
    line("");
    line("template prompt (editable, vesper ui):");
    for (const promptLine of template.prompt.split("\n")) line(`  ${promptLine}`);
  }
  const prompts = template.prompts ?? [];
  if (prompts.length > 0) {
    line("");
    line(dim("the real prompts this pipeline sends ({{...}} = filled in per run):"));
    for (const entry of prompts) {
      line("");
      line(`prompt: ${entry.name}`);
      for (const promptLine of entry.template.split("\n")) line(dim(`  ${promptLine}`));
    }
  } else if (template.prompt.trim().length === 0) {
    line("");
    line(dim("(this pipeline's behavior is built into Vesper — no prompt catalog)"));
  }
  return 0;
}

const showCommand: Command = {
  name: "show",
  summary: "Show a pipeline: doc + capabilities (yours) or its real prompts (built-in).",
  usage: "vesper pipeline show <id>",
  async run({ positionals }) {
    const id = positionals[0];
    if (id === undefined) {
      errorLine("usage: vesper pipeline show <id>");
      return 1;
    }
    const base = await daemonBase();
    if (base === null) return 1;
    const res = await fetch(`${base}/api/pipelines/custom/${encodeURIComponent(id)}`);
    if (!res.ok) {
      // Not one of yours — built-ins expose a read-only prompt catalog instead.
      return showBuiltin(base, id);
    }
    const detail = (await res.json()) as DocDetailish;
    line(`${detail.name}  ${dim(`(${detail.id}, rev ${detail.revision})`)}`);
    line("");
    line("what it can touch:");
    printCapabilities(detail.capabilities);
    line("");
    line(JSON.stringify(detail.doc, null, 2));
    return 0;
  },
};

const saveCommand: Command = {
  name: "save",
  summary: "Validate and save a pipeline document (.md or .json file).",
  usage: "vesper pipeline save <file.md|file.json> [--id <id>] [--validate]",
  async run({ positionals, flags }) {
    const file = positionals[0];
    if (file === undefined) {
      errorLine("usage: vesper pipeline save <file.md|file.json> [--id <id>] [--validate]");
      return 1;
    }
    const base = await daemonBase();
    if (base === null) return 1;

    const loaded = await loadDocFile(base, file);
    if (!loaded.ok) {
      errorLine("the document is not valid:");
      printErrors(loaded.errors);
      return 1;
    }
    const doc = loaded.doc;
    const validation = loaded;
    line(green("document is valid"));
    line("");
    line("this pipeline will be allowed to:");
    printCapabilities(validation.capabilities);
    if (flags.validate === true) return 0;

    const id = strFlag(flags.id) ?? slugify(typeof doc.name === "string" ? doc.name : "") ?? "";
    if (id.length === 0) {
      errorLine("could not derive an id — pass --id <kebab-case-id>");
      return 1;
    }
    line("");
    if (process.stdin.isTTY === true) {
      const answer = await ask(`save as "${id}"? [y/N] `);
      if (answer.toLowerCase() !== "y" && answer.toLowerCase() !== "yes") {
        line(dim("aborted — nothing saved"));
        return 0;
      }
    }
    const code = await collectApproval(base);
    if (code === null) return 1;
    const res = await fetch(`${base}/api/pipelines/custom/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-vesper-approval": code },
      body: JSON.stringify({ doc }),
    });
    const outcome = (await res.json()) as SaveOutcomeish & { error?: string };
    if (!res.ok || !outcome.ok) {
      errorLine(outcome.error ?? "save failed:");
      printErrors(outcome.errors ?? []);
      return 1;
    }
    line(green(`saved — run it with \`vesper pipeline run ${id}\``));
    return 0;
  },
};

const runCommand: Command = {
  name: "run",
  summary: "Run a pipeline now (yours or a built-in).",
  usage: "vesper pipeline run <id> [k=v ...] [--cli <name>]",
  async run({ positionals, flags }) {
    const id = positionals[0];
    if (id === undefined) {
      errorLine("usage: vesper pipeline run <id> [k=v ...]");
      return 1;
    }
    const params: Record<string, string> = {};
    for (const pair of positionals.slice(1)) {
      const eq = pair.indexOf("=");
      if (eq <= 0) {
        errorLine(`params are k=v pairs — got "${pair}"`);
        return 1;
      }
      params[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    const base = await daemonBase();
    if (base === null) return 1;

    // A bare custom id resolves to its task id (`custom:<id>`); built-ins run as-is.
    const custom = await fetch(`${base}/api/pipelines/custom/${encodeURIComponent(id)}`);
    const taskId = custom.ok && !id.startsWith("custom:") ? `custom:${id}` : id;

    const cli = strFlag(flags.cli);
    const res = await fetch(`${base}/api/pipelines/${encodeURIComponent(taskId)}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...(Object.keys(params).length > 0 ? { params } : {}),
        ...(cli !== undefined ? { cli } : {}),
      }),
    });
    const outcome = (await res.json()) as {
      runId?: string | null;
      status?: string;
      summary?: string;
      error?: string;
    };
    if (!res.ok) {
      errorLine(outcome.error ?? `run failed (HTTP ${res.status})`);
      return 1;
    }
    line(`${outcome.status === "ok" ? green(outcome.status ?? "") : yellow(outcome.status ?? "")}`);
    if (outcome.summary !== undefined && outcome.summary.length > 0) line(outcome.summary);
    if (typeof outcome.runId === "string") {
      line(dim(`replay the full terminal: vesper runs replay ${outcome.runId}`));
    }
    return outcome.status === "ok" ? 0 : 1;
  },
};

const improveCommand: Command = {
  name: "improve",
  summary: "Ask Vesper to audit a pipeline: prompt rewrites + model routing.",
  usage: "vesper pipeline improve <id> [--step <stepId>]",
  async run({ positionals, flags }) {
    const id = positionals[0];
    if (id === undefined) {
      errorLine("usage: vesper pipeline improve <id> [--step <stepId>]");
      return 1;
    }
    const base = await daemonBase();
    if (base === null) return 1;
    const scope = strFlag(flags.step);
    line(dim("Vesper is reading the whole pipeline (this is one full CLI call)..."));
    const res = await fetch(`${base}/api/pipelines/custom/${encodeURIComponent(id)}/improve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(scope !== undefined ? { scope } : {}),
    });
    const proposal = (await res.json()) as {
      steps?: Array<{ id: string; prompt?: string; cli?: string; model?: string; reason: string }>;
      orchestratorModel?: string;
      warnings?: string[];
      notes?: string;
      error?: string;
    };
    if (!res.ok) {
      errorLine(proposal.error ?? `improve failed (HTTP ${res.status})`);
      return 1;
    }
    if (proposal.notes !== undefined && proposal.notes.length > 0) line(proposal.notes);
    for (const warning of proposal.warnings ?? []) line(yellow(`  warning: ${warning}`));
    if (proposal.orchestratorModel !== undefined) {
      line(`  orchestrator -> ${proposal.orchestratorModel}`);
    }
    for (const step of proposal.steps ?? []) {
      line("");
      line(`step "${step.id}"  ${dim(step.reason)}`);
      if (step.cli !== undefined || step.model !== undefined) {
        line(`  routing -> ${[step.cli, step.model].filter(Boolean).join(" · ")}`);
      }
      if (step.prompt !== undefined) {
        line(dim("  rewritten prompt:"));
        for (const promptLine of step.prompt.split("\n")) line(`    ${promptLine}`);
      }
    }
    line("");
    line(dim("nothing was changed — apply what you like in the editor (vesper ui) or"));
    line(dim("edit the exported doc and `vesper pipeline save` it."));
    return 0;
  },
};

const rmCommand: Command = {
  name: "rm",
  summary: "Archive one of your pipelines (recoverable — never destroyed).",
  usage: "vesper pipeline rm <id>",
  async run({ positionals }) {
    const id = positionals[0];
    if (id === undefined) {
      errorLine("usage: vesper pipeline rm <id>");
      return 1;
    }
    const base = await daemonBase();
    if (base === null) return 1;
    if (process.stdin.isTTY === true) {
      const answer = await ask(`archive "${id}"? it can be restored by saving it again [y/N] `);
      if (answer.toLowerCase() !== "y" && answer.toLowerCase() !== "yes") {
        line(dim("aborted"));
        return 0;
      }
    }
    const code = await collectApproval(base);
    if (code === null) return 1;
    const res = await fetch(`${base}/api/pipelines/custom/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { "x-vesper-approval": code },
    });
    if (!res.ok) {
      const body = (await res.json()) as { error?: string };
      errorLine(body.error ?? `archive failed (HTTP ${res.status})`);
      return 1;
    }
    line(green("archived"));
    return 0;
  },
};

const exportCommand: Command = {
  name: "export",
  summary: "Write a pipeline's document to markdown (or JSON with --json).",
  usage: "vesper pipeline export <id> [file] [--json]",
  async run({ positionals, flags }) {
    const id = positionals[0];
    if (id === undefined) {
      errorLine("usage: vesper pipeline export <id> [file] [--json]");
      return 1;
    }
    const base = await daemonBase();
    if (base === null) return 1;
    const res = await fetch(`${base}/api/pipelines/custom/${encodeURIComponent(id)}`);
    if (!res.ok) {
      errorLine(`unknown pipeline "${id}"`);
      return 1;
    }
    const detail = (await res.json()) as DocDetailish;
    let output: string;
    if (flags.json === true) {
      output = `${JSON.stringify(detail.doc, null, 2)}\n`;
    } else {
      const md = await fetch(`${base}/api/pipelines/custom/markdown/serialize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ doc: detail.doc }),
      });
      const body = (await md.json()) as { markdown?: string; error?: string };
      if (!md.ok || body.markdown === undefined) {
        errorLine(body.error ?? "could not serialize to markdown");
        return 1;
      }
      output = body.markdown;
    }
    const file = positionals[1];
    if (file === undefined) {
      line(output.trimEnd());
    } else {
      await writeFile(file, output, "utf8");
      line(green(`wrote ${file}`));
    }
    return 0;
  },
};

/** Load a pipeline doc from a .md or .json file, validated through the daemon. */
async function loadDocFile(
  base: string,
  file: string,
): Promise<
  | { ok: true; doc: Record<string, unknown>; capabilities: readonly string[]; errors: [] }
  | { ok: false; errors: readonly string[] }
> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    return { ok: false, errors: [err instanceof Error ? err.message : String(err)] };
  }
  if (file.endsWith(".md")) {
    const res = await fetch(`${base}/api/pipelines/custom/markdown`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: raw }),
    });
    const body = (await res.json()) as SaveOutcomeish & {
      doc?: Record<string, unknown>;
      error?: string;
    };
    if (!res.ok) return { ok: false, errors: [body.error ?? `HTTP ${res.status}`] };
    if (!body.ok || body.doc === undefined) return { ok: false, errors: body.errors };
    return { ok: true, doc: body.doc, capabilities: body.capabilities, errors: [] };
  }
  let doc: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ok: false, errors: ["the file must contain a JSON object (the pipeline document)"] };
    }
    doc = parsed as Record<string, unknown>;
  } catch (err) {
    return { ok: false, errors: [err instanceof Error ? err.message : String(err)] };
  }
  const res = await fetch(`${base}/api/pipelines/custom/validate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ doc }),
  });
  const body = (await res.json()) as SaveOutcomeish & { error?: string };
  if (!res.ok) return { ok: false, errors: [body.error ?? `HTTP ${res.status}`] };
  if (!body.ok) return { ok: false, errors: body.errors };
  return { ok: true, doc, capabilities: body.capabilities, errors: [] };
}

/** A commented starter document for `vesper pipeline new`. */
const STARTER_MD = `---
name: My pipeline
description: what this pipeline is for
orchestrator: on
memory: off
---

# Stage 1

## draft — Draft something

Write the first version of the thing.

# Stage 2

## review — Review it
- after: draft

Review and improve:

{{steps.draft.result}}
`;

const newCommand: Command = {
  name: "new",
  summary: "Write a starter pipeline markdown file you can edit and save.",
  usage: "vesper pipeline new [file.md]",
  async run({ positionals }) {
    const file = positionals[0] ?? "pipeline.md";
    await writeFile(file, STARTER_MD, "utf8");
    line(green(`wrote ${file}`));
    line(dim(`edit it, then: vesper pipeline save ${file}`));
    return 0;
  },
};

const editCommand: Command = {
  name: "edit",
  summary: "Edit a pipeline as markdown in $EDITOR, validate, and save it back.",
  usage: "vesper pipeline edit <id>",
  async run({ positionals }) {
    const id = positionals[0];
    if (id === undefined) {
      errorLine("usage: vesper pipeline edit <id>");
      return 1;
    }
    if (process.stdin.isTTY !== true) {
      errorLine("edit needs an interactive terminal ($EDITOR)");
      return 1;
    }
    const base = await daemonBase();
    if (base === null) return 1;
    const res = await fetch(`${base}/api/pipelines/custom/${encodeURIComponent(id)}`);
    if (!res.ok) {
      errorLine(`unknown pipeline "${id}" (vesper pipeline list)`);
      return 1;
    }
    const detail = (await res.json()) as DocDetailish;
    const md = await fetch(`${base}/api/pipelines/custom/markdown/serialize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ doc: detail.doc }),
    });
    const mdBody = (await md.json()) as { markdown?: string; error?: string };
    if (!md.ok || mdBody.markdown === undefined) {
      errorLine(mdBody.error ?? "could not serialize to markdown");
      return 1;
    }
    const tmp = join(tmpdir(), `vesper-pipeline-${id}.md`);
    await writeFile(tmp, mdBody.markdown, "utf8");

    const editor = process.env.EDITOR ?? process.env.VISUAL ?? "vi";
    const child = Bun.spawn([editor, tmp], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await child.exited;
    if (exitCode !== 0) {
      errorLine(`${editor} exited with code ${exitCode} — nothing saved`);
      return 1;
    }

    const loaded = await loadDocFile(base, tmp);
    if (!loaded.ok) {
      errorLine("the edited document is not valid (your edit is kept at " + tmp + "):");
      printErrors(loaded.errors);
      return 1;
    }
    line(green("document is valid"));
    line("this pipeline will be allowed to:");
    printCapabilities(loaded.capabilities);
    const answer = await ask(`save "${id}"? [y/N] `);
    if (answer.toLowerCase() !== "y" && answer.toLowerCase() !== "yes") {
      line(dim(`aborted — your edit is kept at ${tmp}`));
      return 0;
    }
    const code = await collectApproval(base);
    if (code === null) return 1;
    const put = await fetch(`${base}/api/pipelines/custom/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-vesper-approval": code },
      body: JSON.stringify({ doc: loaded.doc }),
    });
    const outcome = (await put.json()) as SaveOutcomeish & { error?: string };
    if (!put.ok || !outcome.ok) {
      errorLine(outcome.error ?? "save failed:");
      printErrors(outcome.errors ?? []);
      return 1;
    }
    line(green("saved"));
    return 0;
  },
};

const syncCommand: Command = {
  name: "sync",
  summary: "Re-sweep ~/.vesper/pipelines/*.md (every file there IS a pipeline).",
  usage: "vesper pipeline sync",
  async run() {
    const base = await daemonBase();
    if (base === null) return 1;
    const res = await fetch(`${base}/api/pipelines/custom/sync`, { method: "POST" });
    const body = (await res.json()) as {
      loaded?: string[];
      unchanged?: string[];
      errors?: { file: string; errors: string[] }[];
      error?: string;
    };
    if (!res.ok) {
      errorLine(body.error ?? `sync failed (HTTP ${res.status})`);
      return 1;
    }
    line(`loaded: ${body.loaded?.join(", ") || "(none)"}`);
    line(dim(`unchanged: ${body.unchanged?.join(", ") || "(none)"}`));
    for (const failure of body.errors ?? []) {
      errorLine(`${failure.file}: ${failure.errors.join("; ")}`);
    }
    return (body.errors?.length ?? 0) > 0 ? 1 : 0;
  },
};

/** `vesper pipeline ...` — the terminal pipeline editor (same routes as the UI). */
export const pipelineGroup: CommandGroup = {
  name: "pipeline",
  summary: "Author, run, improve, and archive your pipelines (CLI-first editor).",
  subcommands: [
    listCommand,
    showCommand,
    newCommand,
    editCommand,
    saveCommand,
    syncCommand,
    runCommand,
    improveCommand,
    rmCommand,
    exportCommand,
  ],
};

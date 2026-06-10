/**
 * "Improve with AI" (specs/pipeline-editor.md): Vesper reads the ENTIRE pipeline
 * document + the orchestration contracts + the live model-benchmark snapshot and
 * returns a PROPOSAL — per-step prompt rewrites, per-step cli+model routing
 * suggestions with a one-line reason each, and audit warnings. It NEVER mutates:
 * the human accepts per field (the SWE human-gate philosophy).
 *
 * Parsing is fail-closed: suggestions for unknown step ids are dropped, and
 * model/cli suggestions outside the supplied catalog are dropped.
 */

import type { OrchestrationContract } from "../router/contracts.ts";
import type { PipelineDoc } from "./doc.ts";

/** One model row surfaced to the improver (a projection of catalog + benchmarks). */
export interface ImproveModelRow {
  /** Canonical catalog id (what a step's `model` field may name). */
  readonly id: string;
  readonly cli: string;
  readonly tier: string;
  readonly passAt1: number | null;
  readonly meanCostUsd: number | null;
}

/** A proposed change for one step (every field optional; `reason` mandatory). */
export interface StepSuggestion {
  readonly id: string;
  readonly prompt?: string;
  readonly cli?: string;
  readonly model?: string;
  readonly reason: string;
}

/** The whole-document proposal. */
export interface ImproveProposal {
  readonly steps: readonly StepSuggestion[];
  readonly orchestratorModel?: string;
  readonly warnings: readonly string[];
  readonly notes: string;
}

/** Match the inner content of the FIRST fenced code block (optional language tag). */
const FENCE_RE = /```[^\n`]*\r?\n([\s\S]*?)\r?\n```/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asTrimmedString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

/** Build the audit/improve prompt. `scope` narrows suggestions to one step id. */
export function buildImprovePrompt(
  doc: PipelineDoc,
  contracts: Readonly<Record<string, OrchestrationContract>>,
  models: readonly ImproveModelRow[],
  scope?: string,
): string {
  const modelCatalog =
    models.length > 0
      ? models.map(
          (m) =>
            `- ${m.id} (cli ${m.cli}, ${m.tier})` +
            `${m.passAt1 !== null ? ` pass@1 ${(m.passAt1 * 100).toFixed(1)}%` : ""}` +
            `${m.meanCostUsd !== null ? ` ~$${m.meanCostUsd.toFixed(2)}/task` : ""}`,
        )
      : ["- (no benchmark snapshot — suggest routing only when obvious)"];

  const stepLines: string[] = [];
  doc.stages.forEach((stage, i) => {
    stage.tasks.forEach((step) => {
      const routing =
        step.kind === "prompt"
          ? `cli=${step.cli ?? "(default)"} model=${step.model ?? "(default)"}`
          : `target=${step.target} model=${step.model ?? "(default)"}`;
      stepLines.push(
        `- stage ${i + 1}, step "${step.id}" (${step.kind}, ${routing}): ${step.prompt}`,
      );
    });
  });

  return [
    "You are Vesper auditing one of the user's automation pipelines. Review the WHOLE",
    "document, then propose improvements:",
    "1. Rewrite prompts that are vague, unstructured, or poorly formatted (keep intent;",
    "   prefer clear markdown structure, explicit success criteria, terse language).",
    "2. Suggest the right cli+model PER STEP from the model list: the orchestrator and",
    "   judgment-heavy steps deserve a frontier model; code generation belongs on the",
    "   best pass@1-per-dollar; trivial steps belong on the cheapest model.",
    "3. Flag problems as warnings: missing success criteria, steps that ignore prior",
    "   results, capability surprises, unbounded work.",
    ...(scope !== undefined
      ? [`ONLY suggest changes for step "${scope}" (warnings may still cover the whole doc).`]
      : []),
    "",
    `Pipeline "${doc.name}"${doc.description.length > 0 ? ` — ${doc.description}` : ""}:`,
    `- orchestrator: ${doc.orchestrator.enabled ? `enabled (model ${doc.orchestrator.model ?? "(default)"})` : "disabled"}`,
    `- sharing: piped results${doc.sharing.memory ? " + semantic memory" : ""}`,
    ...stepLines,
    "",
    "Invocable pipeline targets (for context):",
    ...Object.values(contracts).map((c) => `- ${c.handlerId}: ${c.summary}`),
    "",
    'Models (canonical id is what you put in "model"):',
    ...modelCatalog,
    "",
    "Reply with ONLY a fenced JSON block:",
    "```json",
    JSON.stringify(
      {
        steps: [
          {
            id: "<step id>",
            prompt: "<rewritten prompt, omit if unchanged>",
            cli: "<cli, omit if unchanged>",
            model: "<canonical model id, omit if unchanged>",
            reason: "<one line>",
          },
        ],
        orchestratorModel: "<canonical id, omit if unchanged>",
        warnings: ["<finding>"],
        notes: "<one-line overall assessment>",
      },
      null,
      1,
    ),
    "```",
  ].join("\n");
}

/**
 * Parse the proposal FAIL-CLOSED against the doc + catalog: unknown step ids are
 * dropped, scope violations are dropped, and cli/model values outside the catalog
 * are stripped from the suggestion (the reason + prompt survive).
 */
export function parseImproveProposal(
  text: string,
  doc: PipelineDoc,
  models: readonly ImproveModelRow[],
  scope?: string,
): ImproveProposal | null {
  const fenced = FENCE_RE.exec(text);
  const candidate = fenced?.[1]?.trim() ?? text.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const knownIds = new Set<string>();
  for (const stage of doc.stages) for (const step of stage.tasks) knownIds.add(step.id);
  const knownModels = new Set(models.map((m) => m.id));
  const knownClis = new Set(models.map((m) => m.cli));

  const steps: StepSuggestion[] = [];
  if (Array.isArray(parsed.steps)) {
    for (const raw of parsed.steps) {
      if (!isRecord(raw)) continue;
      const id = asTrimmedString(raw.id);
      if (id === undefined || !knownIds.has(id)) continue;
      if (scope !== undefined && id !== scope) continue;
      const reason = asTrimmedString(raw.reason) ?? "";
      const prompt = asTrimmedString(raw.prompt);
      const cliRaw = asTrimmedString(raw.cli);
      const modelRaw = asTrimmedString(raw.model);
      const cli = cliRaw !== undefined && knownClis.has(cliRaw) ? cliRaw : undefined;
      const model = modelRaw !== undefined && knownModels.has(modelRaw) ? modelRaw : undefined;
      if (prompt === undefined && cli === undefined && model === undefined) continue;
      steps.push({
        id,
        reason,
        ...(prompt !== undefined ? { prompt } : {}),
        ...(cli !== undefined ? { cli } : {}),
        ...(model !== undefined ? { model } : {}),
      });
    }
  }

  const orchestratorModelRaw = asTrimmedString(parsed.orchestratorModel);
  const orchestratorModel =
    orchestratorModelRaw !== undefined && knownModels.has(orchestratorModelRaw)
      ? orchestratorModelRaw
      : undefined;

  const warnings: string[] = [];
  if (Array.isArray(parsed.warnings)) {
    for (const w of parsed.warnings) {
      const warning = asTrimmedString(w);
      if (warning !== undefined) warnings.push(warning);
    }
  }
  const notes = asTrimmedString(parsed.notes) ?? "";

  if (steps.length === 0 && warnings.length === 0 && orchestratorModel === undefined) {
    return null;
  }
  return {
    steps,
    ...(orchestratorModel !== undefined ? { orchestratorModel } : {}),
    warnings,
    notes,
  };
}

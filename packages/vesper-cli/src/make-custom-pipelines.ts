/**
 * The daemon-side custom-pipelines surface (specs/pipeline-editor.md): ONE place
 * that validates, persists, (re)registers, archives, and improves user-authored
 * pipelines. The UI server's routes and (through them) the `vesper pipeline` CLI
 * both consume THIS object, so CLI/UI parity is structural — there is no second
 * code path to drift.
 *
 * Follows the make-software-engineer.ts precedent: the interface lives in
 * `@vesper/ui` (UiServerDeps.customPipelines); this factory builds the instance.
 */

import type {
  Capability,
  CompleteFn,
  HandlerRegistry,
  ModelBenchmarkRow,
  ModelCatalogEntry,
  Scheduler,
  Store,
} from "@vesper/core";
import {
  buildImprovePrompt,
  type CustomPipelineDeps,
  deriveCapabilities,
  type ImproveModelRow,
  type ImproveProposal,
  isValidCustomPipelineId,
  parseImproveProposal,
  parsePipelineDoc,
  parsePipelineMarkdown,
  registerCustomPipeline,
  serializePipelineMarkdown,
  unregisterCustomPipeline,
} from "@vesper/pipelines";
import type {
  CustomPipelineDetail,
  CustomPipelineSummary,
  CustomPipelinesSurface,
  SaveCustomPipelineOutcome,
} from "@vesper/ui";

/** Per-call timeout for the improve completion (a full-document audit). */
const IMPROVE_TIMEOUT_MS = 300_000;

/** Project catalog + benchmark snapshot into the improver's model rows. */
export function improveModelRows(
  catalog: Readonly<Record<string, ModelCatalogEntry>>,
  benchmarks: readonly ModelBenchmarkRow[],
): ImproveModelRow[] {
  return Object.entries(catalog).map(([id, entry]) => {
    const row = benchmarks.find((b) => entry.benchmarkNames?.includes(b.model) === true);
    return {
      id,
      cli: entry.cli,
      tier: entry.tier,
      passAt1: row?.passAt1 ?? null,
      meanCostUsd: row?.meanCostUsd ?? null,
    };
  });
}

export interface MakeCustomPipelinesOptions {
  readonly store: Store;
  readonly scheduler: Scheduler;
  readonly registry: HandlerRegistry;
  /** The interpreter deps (contracts, skill reader, sibling runner, memory...). */
  readonly deps: CustomPipelineDeps;
  /** The configured-CLI completion seam (the improve brain — Hard rule 12). */
  readonly complete: CompleteFn;
  /** Live model rows for routing suggestions (catalog + benchmark snapshot). */
  readonly modelRows: () => ImproveModelRow[];
}

export function makeCustomPipelinesSurface(
  options: MakeCustomPipelinesOptions,
): CustomPipelinesSurface {
  const { store, scheduler, registry, deps, complete, modelRows } = options;

  const capabilitiesOf = (doc: Record<string, unknown>): readonly Capability[] => {
    const parsed = parsePipelineDoc(doc, deps.contracts);
    return parsed.ok ? deriveCapabilities(parsed.doc, deps.contracts) : [];
  };

  return {
    list(): CustomPipelineSummary[] {
      return store.listCustomPipelines({ status: "active" }).map((row) => ({
        id: row.id,
        name: row.name,
        revision: row.revision,
        tsUpdated: row.tsUpdated,
        capabilities: capabilitiesOf(row.doc),
      }));
    },

    targets() {
      return Object.values(deps.contracts).map((c) => ({
        handlerId: c.handlerId,
        summary: c.summary,
        paramKeys: c.paramKeys,
        promptParam: c.promptParam,
        acceptsModel: c.acceptsModel,
      }));
    },

    get(id: string): CustomPipelineDetail | null {
      const row = store.getCustomPipeline(id);
      if (row === null || row.status !== "active") return null;
      return {
        id: row.id,
        name: row.name,
        revision: row.revision,
        tsUpdated: row.tsUpdated,
        doc: row.doc,
        capabilities: capabilitiesOf(row.doc),
      };
    },

    validate(doc: Record<string, unknown>): SaveCustomPipelineOutcome {
      const parsed = parsePipelineDoc(doc, deps.contracts);
      if (!parsed.ok) return { ok: false, capabilities: [], errors: parsed.errors };
      return {
        ok: true,
        capabilities: deriveCapabilities(parsed.doc, deps.contracts),
        errors: [],
      };
    },

    save(id: string, doc: Record<string, unknown>): SaveCustomPipelineOutcome {
      if (!isValidCustomPipelineId(id)) {
        return { ok: false, capabilities: [], errors: [`invalid pipeline id "${id}"`] };
      }
      const parsed = parsePipelineDoc(doc, deps.contracts);
      if (!parsed.ok) {
        return { ok: false, capabilities: [], errors: parsed.errors };
      }
      store.upsertCustomPipeline({ id, name: parsed.doc.name, doc });
      const result = registerCustomPipeline(scheduler, registry, { id, doc }, deps);
      store.appendEvent({
        source: "custom-pipelines",
        kind: "custom_pipeline_saved",
        payload: { id, revision: store.getCustomPipeline(id)?.revision ?? null, ok: result.ok },
      });
      return { ok: result.ok, capabilities: result.capabilities, errors: result.errors };
    },

    archive(id: string): boolean {
      const archived = store.archiveCustomPipeline(id);
      if (archived) {
        unregisterCustomPipeline(scheduler, id);
        store.appendEvent({
          source: "custom-pipelines",
          kind: "custom_pipeline_archived",
          payload: { id },
        });
      }
      return archived;
    },

    parseMarkdown(source: string) {
      const parsed = parsePipelineMarkdown(source);
      if (!parsed.ok) return { ok: false, capabilities: [], errors: parsed.errors };
      const validated = parsePipelineDoc(parsed.doc, deps.contracts);
      if (!validated.ok) return { ok: false, capabilities: [], errors: validated.errors };
      return {
        ok: true,
        capabilities: deriveCapabilities(validated.doc, deps.contracts),
        errors: [],
        doc: parsed.doc,
      };
    },

    serializeMarkdown(doc: Record<string, unknown>): string | null {
      const validated = parsePipelineDoc(doc, deps.contracts);
      if (!validated.ok) return null;
      return serializePipelineMarkdown(doc);
    },

    async improve(id: string, scope?: string): Promise<ImproveProposal | null> {
      const row = store.getCustomPipeline(id);
      if (row === null || row.status !== "active") return null;
      const parsed = parsePipelineDoc(row.doc, deps.contracts);
      if (!parsed.ok) return null;
      const models = modelRows();
      const prompt = buildImprovePrompt(parsed.doc, deps.contracts, models, scope);
      const reply = await complete(prompt, { timeoutMs: IMPROVE_TIMEOUT_MS });
      return parseImproveProposal(reply.text, parsed.doc, models, scope);
    },
  };
}

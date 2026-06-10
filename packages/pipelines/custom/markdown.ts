/**
 * Markdown <-> PipelineDoc converter (specs/markdown-pipelines.md).
 *
 * A pipeline IS one markdown file: `---` frontmatter, `# Stage` headings, and
 * `## <id> — <title>` step headings whose leading contiguous dash-list carries
 * attributes and whose remainder is the verbatim prompt body. Hand-rolled (no
 * yaml/marked dependency), fail-closed with line-numbered errors, and lossless:
 * `serializePipelineMarkdown(doc)` parses back to an identical raw doc.
 *
 * This module produces and accepts the RAW doc shape only (`Record<string,
 * unknown>`): `parsePipelineDoc` (doc.ts) stays the validator the caller runs
 * afterwards, so optional fields another change adds (`layout`, step `after`)
 * flow through without this file depending on them at the type level.
 */

/** Mirrors doc.ts ID_RE — the step-id shape (`custom:<id>` must stay unambiguous). */
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FRONTMATTER_LINE_RE = /^([A-Za-z][A-Za-z0-9-]*):(?:\s+(.*))?$/;
const ATTR_RE = /^-\s+([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/;
const STEP_HEADING_RE = /^(\S+)\s+(?:—|--)\s+(.+)$/;
const PIPELINE_SUFFIX_RE = /\(pipeline:\s*([^)]*)\)\s*$/;
const AT_RE = /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/;
const FENCE_RE = /^\s*```/;

export type MarkdownParseResult =
  | { readonly ok: true; readonly doc: Record<string, unknown> }
  | { readonly ok: false; readonly errors: readonly string[] };

/** Frontmatter accumulator (defaults applied: orchestrator on, memory off). */
interface Frontmatter {
  nameSeen: boolean;
  name: string;
  description: string;
  orchestratorEnabled: boolean;
  orchestratorModel?: string;
  instructions?: string;
  memory: boolean;
}

/** In-flight step while scanning its attribute list + body. */
interface StepDraft {
  readonly id: string;
  readonly title: string;
  readonly target?: string;
  /** Heading was malformed or stageless — consume its lines, emit nothing. */
  readonly invalid: boolean;
  attrsOpen: boolean;
  readonly attrKeys: Set<string>;
  cli?: string;
  model?: string;
  command?: string;
  skills?: readonly string[];
  after?: readonly string[];
  at?: { readonly x: number; readonly y: number };
  readonly params: Record<string, string>;
  readonly body: string[];
}

function parseOnOff(value: string, key: string, n: number, errors: string[]): boolean | undefined {
  if (value === "on") return true;
  if (value === "off") return false;
  errors.push(`line ${n}: ${key} must be "on" or "off"`);
  return undefined;
}

function trimBlankEdges(lines: readonly string[]): readonly string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && (lines[start] ?? "").trim() === "") start++;
  while (end > start && (lines[end - 1] ?? "").trim() === "") end--;
  return lines.slice(start, end);
}

/** Block scalar: consume lines indented by 2 spaces (blank lines kept only when interior). */
function readBlockScalar(lines: readonly string[], start: number): { text: string; next: number } {
  const block: string[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.startsWith("  ")) {
      block.push(line.slice(2));
      i++;
      continue;
    }
    if (line.trim() === "") {
      let j = i + 1;
      while (j < lines.length && (lines[j] ?? "").trim() === "") j++;
      if (j < lines.length && (lines[j] ?? "").startsWith("  ")) {
        for (let k = i; k < j; k++) block.push("");
        i = j;
        continue;
      }
    }
    break;
  }
  return { text: trimBlankEdges(block).join("\n"), next: i };
}

/** Parse the frontmatter; returns the index just past the closing `---`, or undefined on a fatal shape error. */
function parseFrontmatter(
  lines: readonly string[],
  openIndex: number,
  fm: Frontmatter,
  errors: string[],
): number | undefined {
  let i = openIndex + 1;
  const seen = new Set<string>();
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const n = i + 1;
    if (line.trim() === "---") return i + 1;
    if (line.trim() === "") {
      i++;
      continue;
    }
    const match = FRONTMATTER_LINE_RE.exec(line);
    if (match === null) {
      errors.push(`line ${n}: frontmatter line must be "key: value"`);
      i++;
      continue;
    }
    const key = match[1] ?? "";
    const value = (match[2] ?? "").trim();
    if (seen.has(key)) {
      errors.push(`line ${n}: duplicate frontmatter key "${key}"`);
      i++;
      continue;
    }
    seen.add(key);
    switch (key) {
      case "name":
        fm.nameSeen = true;
        fm.name = value;
        i++;
        break;
      case "description":
        fm.description = value;
        i++;
        break;
      case "orchestrator": {
        const enabled = parseOnOff(value, "orchestrator", n, errors);
        if (enabled !== undefined) fm.orchestratorEnabled = enabled;
        i++;
        break;
      }
      case "orchestrator-model":
        if (value === "") errors.push(`line ${n}: orchestrator-model must have a value`);
        else fm.orchestratorModel = value;
        i++;
        break;
      case "orchestrator-instructions":
        if (value === "|") {
          const block = readBlockScalar(lines, i + 1);
          if (block.text !== "") fm.instructions = block.text;
          i = block.next;
        } else if (value !== "") {
          fm.instructions = value;
          i++;
        } else {
          errors.push(
            `line ${n}: orchestrator-instructions must be "|" followed by indented lines`,
          );
          i++;
        }
        break;
      case "memory": {
        const memory = parseOnOff(value, "memory", n, errors);
        if (memory !== undefined) fm.memory = memory;
        i++;
        break;
      }
      default:
        errors.push(`line ${n}: unknown frontmatter key "${key}"`);
        i++;
    }
  }
  errors.push(`line ${openIndex + 1}: frontmatter never closed with "---"`);
  return undefined;
}

function parseStepHeading(line: string, n: number, hasStage: boolean, errors: string[]): StepDraft {
  let text = line.slice(2).trim();
  let target: string | undefined;
  const suffix = PIPELINE_SUFFIX_RE.exec(text);
  let invalid = !hasStage;
  if (suffix !== null) {
    target = (suffix[1] ?? "").trim();
    text = text.slice(0, suffix.index).trim();
    if (target === "") {
      errors.push(`line ${n}: pipeline target must not be empty`);
      invalid = true;
    }
  }
  const heading = STEP_HEADING_RE.exec(text);
  let id = "invalid";
  let title = "";
  if (heading === null) {
    errors.push(`line ${n}: step heading must be "## <id> — <title>"`);
    invalid = true;
  } else {
    id = heading[1] ?? "";
    title = (heading[2] ?? "").trim();
    if (!ID_RE.test(id)) {
      errors.push(`line ${n}: step id "${id}" must match ${ID_RE.source}`);
      invalid = true;
    }
  }
  return {
    id,
    title,
    ...(target !== undefined && target !== "" ? { target } : {}),
    invalid,
    attrsOpen: true,
    attrKeys: new Set<string>(),
    params: {},
    body: [],
  };
}

function splitCommaList(value: string): readonly string[] {
  return value.split(",").map((entry) => entry.trim());
}

function handleAttr(
  step: StepDraft,
  key: string,
  rawValue: string,
  n: number,
  errors: string[],
): void {
  const value = rawValue.trim();
  if (step.attrKeys.has(key)) {
    errors.push(`line ${n}: duplicate attribute "${key}"`);
    return;
  }
  step.attrKeys.add(key);
  if (value === "") {
    errors.push(`line ${n}: attribute "${key}" must have a value`);
    return;
  }
  const isPipeline = step.target !== undefined;
  switch (key) {
    case "model":
      step.model = value;
      return;
    case "after": {
      const entries = splitCommaList(value);
      for (const entry of entries) {
        if (!ID_RE.test(entry)) {
          errors.push(`line ${n}: after entry "${entry}" is not a valid step id`);
          return;
        }
      }
      step.after = entries;
      return;
    }
    case "at": {
      const match = AT_RE.exec(value);
      if (match === null) {
        errors.push(`line ${n}: at must be "x,y" (two numbers)`);
        return;
      }
      step.at = { x: Number(match[1]), y: Number(match[2]) };
      return;
    }
    case "cli":
    case "command": {
      if (isPipeline) {
        errors.push(`line ${n}: "${key}" is only valid on prompt steps`);
        return;
      }
      if (key === "cli") step.cli = value;
      else step.command = value;
      return;
    }
    case "skills": {
      if (isPipeline) {
        errors.push(`line ${n}: "skills" is only valid on prompt steps`);
        return;
      }
      const skills = splitCommaList(value);
      for (const skill of skills) {
        if (skill === "") {
          errors.push(`line ${n}: skills entries must be non-empty`);
          return;
        }
      }
      step.skills = skills;
      return;
    }
    default: {
      if (!isPipeline) {
        errors.push(
          `line ${n}: unknown attribute "${key}" on prompt step ` +
            "(params are only valid on pipeline steps)",
        );
        return;
      }
      step.params[key] = value;
    }
  }
}

function buildStep(draft: StepDraft): Record<string, unknown> {
  const prompt = trimBlankEdges(draft.body).join("\n");
  if (draft.target !== undefined) {
    return {
      kind: "pipeline",
      id: draft.id,
      title: draft.title,
      target: draft.target,
      prompt,
      ...(Object.keys(draft.params).length > 0 ? { params: draft.params } : {}),
      ...(draft.model !== undefined ? { model: draft.model } : {}),
      ...(draft.after !== undefined ? { after: draft.after } : {}),
    };
  }
  return {
    kind: "prompt",
    id: draft.id,
    title: draft.title,
    prompt,
    ...(draft.skills !== undefined ? { skills: draft.skills } : {}),
    ...(draft.command !== undefined ? { command: draft.command } : {}),
    ...(draft.cli !== undefined ? { cli: draft.cli } : {}),
    ...(draft.model !== undefined ? { model: draft.model } : {}),
    ...(draft.after !== undefined ? { after: draft.after } : {}),
  };
}

/**
 * Parse a pipeline markdown document into the RAW doc shape. Fail-closed: every
 * grammar problem is reported with its line number and any error invalidates the
 * whole document. The caller validates the result with `parsePipelineDoc`.
 */
export function parsePipelineMarkdown(source: string): MarkdownParseResult {
  const lines = source.split("\n");
  const errors: string[] = [];

  let i = 0;
  while (i < lines.length && (lines[i] ?? "").trim() === "") i++;
  if ((lines[i] ?? "").trim() !== "---") {
    return { ok: false, errors: [`line ${i + 1}: expected "---" to open frontmatter`] };
  }
  const fm: Frontmatter = {
    nameSeen: false,
    name: "",
    description: "",
    orchestratorEnabled: true,
    memory: false,
  };
  const afterFrontmatter = parseFrontmatter(lines, i, fm, errors);
  if (afterFrontmatter === undefined) return { ok: false, errors };
  i = afterFrontmatter;

  const stages: { tasks: Record<string, unknown>[] }[] = [];
  const layout: Record<string, { readonly x: number; readonly y: number }> = {};
  let step: StepDraft | undefined;
  let inFence = false;

  const finalizeStep = (): void => {
    if (step === undefined) return;
    const stage = stages[stages.length - 1];
    if (!step.invalid && stage !== undefined) {
      stage.tasks.push(buildStep(step));
      if (step.at !== undefined) layout[step.id] = step.at;
    }
    step = undefined;
    inFence = false;
  };

  for (; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const n = i + 1;
    if (step !== undefined && inFence) {
      step.body.push(line);
      if (FENCE_RE.test(line)) inFence = false;
      continue;
    }
    if (/^#\s/.test(line)) {
      finalizeStep();
      if (/^# Stage(\s|$)/.test(line)) stages.push({ tasks: [] });
      else
        errors.push(
          `line ${n}: unexpected heading (expected "# Stage ..." or "## <id> — <title>")`,
        );
      continue;
    }
    if (/^##\s/.test(line)) {
      finalizeStep();
      if (stages.length === 0) errors.push(`line ${n}: step heading before any "# Stage" heading`);
      step = parseStepHeading(line, n, stages.length > 0, errors);
      continue;
    }
    if (step?.attrsOpen) {
      const attr = ATTR_RE.exec(line);
      if (attr !== null) {
        handleAttr(step, attr[1] ?? "", attr[2] ?? "", n, errors);
        continue;
      }
      step.attrsOpen = false;
    }
    if (step !== undefined) {
      step.body.push(line);
      if (FENCE_RE.test(line)) inFence = true;
      continue;
    }
    if (line.trim() !== "") errors.push(`line ${n}: content outside a step`);
  }
  finalizeStep();

  if (errors.length > 0) return { ok: false, errors };
  const doc: Record<string, unknown> = {
    v: 1,
    ...(fm.nameSeen ? { name: fm.name } : {}),
    description: fm.description,
    orchestrator: {
      enabled: fm.orchestratorEnabled,
      ...(fm.orchestratorModel !== undefined ? { model: fm.orchestratorModel } : {}),
      ...(fm.instructions !== undefined ? { instructions: fm.instructions } : {}),
    },
    sharing: { mode: "piped", memory: fm.memory },
    stages,
    ...(Object.keys(layout).length > 0 ? { layout } : {}),
  };
  return { ok: true, doc };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asStringList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const entries = value.filter((entry): entry is string => typeof entry === "string");
  return entries.length === value.length ? entries : undefined;
}

function atLine(layout: Record<string, unknown> | undefined, id: string): string | undefined {
  const point = asRecord(layout?.[id]);
  if (point === undefined) return undefined;
  const { x, y } = point;
  if (typeof x !== "number" || typeof y !== "number") return undefined;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  return `- at: ${x},${y}`;
}

function serializeStep(
  step: Record<string, unknown>,
  layout: Record<string, unknown> | undefined,
): string {
  const id = asNonEmptyString(step.id) ?? "";
  const title = asNonEmptyString(step.title) ?? id;
  const target = step.kind === "pipeline" ? asNonEmptyString(step.target) : undefined;
  const heading =
    target !== undefined ? `## ${id} — ${title} (pipeline: ${target})` : `## ${id} — ${title}`;
  const attrs: string[] = [];
  const model = asNonEmptyString(step.model);
  if (target === undefined) {
    const cli = asNonEmptyString(step.cli);
    if (cli !== undefined) attrs.push(`- cli: ${cli}`);
    if (model !== undefined) attrs.push(`- model: ${model}`);
    const skills = asStringList(step.skills);
    if (skills !== undefined) attrs.push(`- skills: ${skills.join(", ")}`);
    const command = asNonEmptyString(step.command);
    if (command !== undefined) attrs.push(`- command: ${command}`);
  } else {
    if (model !== undefined) attrs.push(`- model: ${model}`);
    const params = asRecord(step.params) ?? {};
    for (const key of Object.keys(params).sort()) {
      const value = asNonEmptyString(params[key]);
      if (value !== undefined) attrs.push(`- ${key}: ${value}`);
    }
  }
  const after = asStringList(step.after);
  if (after !== undefined) attrs.push(`- after: ${after.join(", ")}`);
  const at = atLine(layout, id);
  if (at !== undefined) attrs.push(at);
  const head = [heading, ...attrs].join("\n");
  const prompt = typeof step.prompt === "string" ? step.prompt : "";
  return prompt === "" ? head : `${head}\n\n${prompt}`;
}

/**
 * Serialize a raw doc (already validated by the caller) back to markdown.
 * Defaults are omitted (orchestrator on, memory off, empty description, empty
 * attr lists) so `parsePipelineMarkdown(serializePipelineMarkdown(doc))` yields
 * an identical raw doc.
 */
export function serializePipelineMarkdown(doc: Record<string, unknown>): string {
  const fm: string[] = ["---", `name: ${asNonEmptyString(doc.name) ?? ""}`];
  const description = asNonEmptyString(doc.description);
  if (description !== undefined) fm.push(`description: ${description}`);
  const orchestrator = asRecord(doc.orchestrator);
  if (orchestrator?.enabled === false) fm.push("orchestrator: off");
  const orchestratorModel = asNonEmptyString(orchestrator?.model);
  if (orchestratorModel !== undefined) fm.push(`orchestrator-model: ${orchestratorModel}`);
  const instructions = asNonEmptyString(orchestrator?.instructions);
  if (instructions !== undefined) {
    fm.push("orchestrator-instructions: |");
    for (const line of instructions.split("\n")) fm.push(line === "" ? "" : `  ${line}`);
  }
  const sharing = asRecord(doc.sharing);
  if (sharing?.memory === true) fm.push("memory: on");
  fm.push("---");

  const blocks: string[] = [fm.join("\n")];
  const layout = asRecord(doc.layout);
  const stages = Array.isArray(doc.stages) ? doc.stages : [];
  stages.forEach((rawStage, index) => {
    blocks.push(`# Stage ${index + 1}`);
    const stage = asRecord(rawStage);
    const tasks = Array.isArray(stage?.tasks) ? stage.tasks : [];
    for (const rawTask of tasks) {
      const task = asRecord(rawTask);
      if (task !== undefined) blocks.push(serializeStep(task, layout));
    }
  });
  return `${blocks.join("\n\n")}\n`;
}

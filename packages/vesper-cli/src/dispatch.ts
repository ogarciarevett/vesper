import { VesperError } from "@vesper/core";
import { type ParsedArgs, parseArgs } from "./args.ts";
import { agentFace } from "./banner.ts";
import { bold, cyan, dim, errorLine, line } from "./ui.ts";

/** A leaf command, e.g. `vesper init` or `vesper vault set`. */
export interface Command {
  readonly name: string;
  readonly summary: string;
  /** Usage hint shown in help, e.g. `vesper vault set <key>`. */
  readonly usage?: string;
  /** Execute the command; return a process exit code. */
  run(args: ParsedArgs): Promise<number> | number;
}

/** A namespace of subcommands, e.g. `vesper vault ...`. */
export interface CommandGroup {
  readonly name: string;
  readonly summary: string;
  readonly subcommands: readonly Command[];
}

/** Anything registered at the top level. */
export type Registrable = Command | CommandGroup;

const PROGRAM = "vesper";

/**
 * Flags that take a space-separated value (e.g. `--cli claude`). Listed centrally
 * so the parser treats them as valued; everything else stays a boolean flag.
 */
const VALUE_FLAGS: ReadonlySet<string> = new Set(["cli", "param", "pipeline", "status", "limit"]);

function isGroup(entry: Registrable): entry is CommandGroup {
  return "subcommands" in entry;
}

function formatError(err: unknown): string {
  if (err instanceof VesperError) return `[${err.code}] ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

function printBanner(): void {
  const { lines, id } = agentFace();
  for (const row of lines) line(cyan(`  ${row}`));
  line(dim(`  agent · ${id}`));
}

function printTopHelp(registry: readonly Registrable[]): void {
  printBanner();
  line(bold(`${PROGRAM} — a local-first runtime for personal automation agents`));
  line();
  line(`${bold("Usage:")} ${PROGRAM} <command> [options]`);
  line();
  line(bold("Commands:"));
  const width = registry.reduce((max, entry) => Math.max(max, entry.name.length), 0);
  for (const entry of registry) {
    line(`  ${cyan(entry.name.padEnd(width))}  ${entry.summary}`);
  }
  line();
  line(dim(`Run "${PROGRAM} <command> --help" for command details.`));
}

function printGroupHelp(group: CommandGroup): void {
  line(`${bold("Usage:")} ${PROGRAM} ${group.name} <subcommand> [options]`);
  line();
  line(group.summary);
  line();
  line(bold("Subcommands:"));
  const width = group.subcommands.reduce((max, cmd) => Math.max(max, cmd.name.length), 0);
  for (const cmd of group.subcommands) {
    line(`  ${cyan(cmd.name.padEnd(width))}  ${cmd.summary}`);
  }
}

function printCommandHelp(prefix: string, cmd: Command): void {
  line(`${bold("Usage:")} ${cmd.usage ?? `${PROGRAM} ${prefix}${cmd.name}`}`);
  line();
  line(cmd.summary);
}

async function runSafely(cmd: Command, args: ParsedArgs): Promise<number> {
  try {
    return await cmd.run(args);
  } catch (err) {
    errorLine(formatError(err));
    return 1;
  }
}

/**
 * Resolve `argv` against the registry and execute the matched command. Renders
 * help for `--help`, no command, or `help`. Unknown commands print help and
 * return exit code 1. Thrown errors are caught and printed as one actionable line.
 */
export async function dispatch(
  registry: readonly Registrable[],
  argv: readonly string[],
): Promise<number> {
  const { positionals, flags } = parseArgs(argv, VALUE_FLAGS);
  const wantsHelp = flags.help === true;
  const first = positionals[0];

  if (first === undefined || first === "help") {
    printTopHelp(registry);
    return 0;
  }

  const entry = registry.find((candidate) => candidate.name === first);
  if (entry === undefined) {
    errorLine(`unknown command "${first}"`);
    line();
    printTopHelp(registry);
    return 1;
  }

  if (isGroup(entry)) {
    const subName = positionals[1];
    if (subName === undefined) {
      printGroupHelp(entry);
      return wantsHelp ? 0 : 1;
    }
    const sub = entry.subcommands.find((candidate) => candidate.name === subName);
    if (sub === undefined) {
      errorLine(`unknown subcommand "${entry.name} ${subName}"`);
      line();
      printGroupHelp(entry);
      return 1;
    }
    if (wantsHelp) {
      printCommandHelp(`${entry.name} `, sub);
      return 0;
    }
    return runSafely(sub, { positionals: positionals.slice(2), flags });
  }

  if (wantsHelp) {
    printCommandHelp("", entry);
    return 0;
  }
  return runSafely(entry, { positionals: positionals.slice(1), flags });
}

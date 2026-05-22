import type { Registrable } from "../dispatch.ts";
import { cliGroup } from "./cli.ts";
import { daemonCommand } from "./daemon.ts";
import { helloCommand } from "./hello.ts";
import { initCommand } from "./init.ts";
import { scheduleGroup } from "./schedule.ts";
import { statusCommand } from "./status.ts";
import { vaultGroup } from "./vault.ts";

/** Top-level command registry. New commands/groups register here — no central switch. */
export const registry: readonly Registrable[] = [
  initCommand,
  helloCommand,
  vaultGroup,
  cliGroup,
  statusCommand,
  daemonCommand,
  scheduleGroup,
];

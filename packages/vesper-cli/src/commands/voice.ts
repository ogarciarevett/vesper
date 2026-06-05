import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  type CompleteFn,
  createVoiceProvider,
  DEFAULT_VOICE_SETTINGS,
  detectAvailableCLIs,
  openStore,
  runProcess,
  runVoiceTurn,
  type VoiceAuditStore,
  VoiceError,
  type VoiceProvider,
  type VoiceSettings,
  type VoiceTurnSettings,
} from "@vesper/core";
import type { ParsedArgs } from "../args.ts";
import { makeCompleteFn } from "../cli-resolver.ts";
import { loadConfig, type VesperConfig } from "../config.ts";
import type { Command, CommandGroup } from "../dispatch.ts";
import { dbPath, vesperHome } from "../paths.ts";
import { cyan, dim, line } from "../ui.ts";

// ----------------------------------------------------------------------------
// Testable core — pure helpers that take injected deps (no real process/store).
// ----------------------------------------------------------------------------

/** Inputs for {@link runSay}. */
export interface SayDeps {
  readonly provider: VoiceProvider;
  readonly text: string;
  readonly out: (line: string) => void;
}

/** Speak `text` aloud through the provider. Returns a process exit code. */
export async function runSay(deps: SayDeps): Promise<number> {
  const text = deps.text.trim();
  if (text.length === 0) {
    deps.out("nothing to say (provide text)");
    return 1;
  }
  try {
    await deps.provider.speak(text);
    deps.out(dim(`spoke ${text.length} chars`));
    return 0;
  } catch (cause) {
    if (cause instanceof VoiceError && cause.reason === "tts_unavailable") {
      deps.out(`local text-to-speech is unavailable: ${cause.message}`);
      return 1;
    }
    throw cause;
  }
}

/** Inputs for {@link runAsk}. */
export interface AskDeps {
  readonly transcript: string;
  readonly brain: (prompt: string) => AsyncIterable<string>;
  readonly provider: VoiceProvider;
  readonly store: VoiceAuditStore;
  readonly settings: VoiceTurnSettings;
  readonly out: (line: string) => void;
}

/** Run one voice turn: transcript -> brain -> printed (and optionally spoken) reply. */
export async function runAsk(deps: AskDeps): Promise<number> {
  const transcript = deps.transcript.trim();
  if (transcript.length === 0) {
    deps.out("nothing to ask (provide text)");
    return 1;
  }
  const result = await runVoiceTurn({
    transcript,
    brain: deps.brain,
    provider: deps.provider,
    store: deps.store,
    settings: deps.settings,
  });
  deps.out(result.reply);
  return 0;
}

// ----------------------------------------------------------------------------
// Host wiring — builds the real provider/brain/store and delegates to helpers.
// ----------------------------------------------------------------------------

/** The resolved voice settings, or the fully-local default when unset. */
function voiceSettings(config: VesperConfig): VoiceSettings {
  return config.voice ?? DEFAULT_VOICE_SETTINGS;
}

/** The local, on-device voice provider (macOS `say` for TTS). */
function localProvider(): VoiceProvider {
  return createVoiceProvider("local", { runner: runProcess });
}

/** Wrap a CLI completion into the streaming-brain shape `runVoiceTurn` expects. */
function cliBrain(
  complete: CompleteFn,
  cliOverride?: string,
): (prompt: string) => AsyncIterable<string> {
  return (prompt) =>
    (async function* () {
      const result = await complete(prompt, cliOverride !== undefined ? { cli: cliOverride } : {});
      yield result.text;
    })();
}

/** The runtime a conversational turn needs, resolved from config + installed CLIs + flags. */
interface VoiceRuntime {
  readonly brain: (prompt: string) => AsyncIterable<string>;
  readonly provider: VoiceProvider;
  readonly settings: VoiceTurnSettings;
}

/** Resolve the brain (default CLI), local provider, and per-run settings. `--silent` mutes TTS. */
async function resolveVoiceRuntime(flags: ParsedArgs["flags"]): Promise<VoiceRuntime> {
  const config = await loadConfig();
  const installed = await detectAvailableCLIs();
  const complete = makeCompleteFn(config, installed);
  const cliOverride = typeof flags.cli === "string" ? flags.cli : undefined;
  const base = voiceSettings(config);
  return {
    brain: cliBrain(complete, cliOverride),
    provider: localProvider(),
    settings: {
      brain: base.brain,
      tts: base.tts,
      speakReplies: flags.silent === true ? false : base.speakReplies,
    },
  };
}

const sayCommand: Command = {
  name: "say",
  summary: "Speak text aloud with the local system voice (macOS `say`).",
  usage: 'vesper voice say "<text>"',
  run({ positionals, flags }) {
    const text = typeof flags.text === "string" ? flags.text : positionals.join(" ");
    return runSay({ provider: localProvider(), text, out: line });
  },
};

const askCommand: Command = {
  name: "ask",
  summary: "Ask Vesper (your CLI is the brain); print the reply and speak it aloud.",
  usage: 'vesper voice ask "<question>" [--cli <name>] [--silent]',
  async run({ positionals, flags }) {
    const { brain, provider, settings } = await resolveVoiceRuntime(flags);
    const store = openStore(dbPath());
    try {
      return await runAsk({
        transcript: typeof flags.text === "string" ? flags.text : positionals.join(" "),
        brain,
        provider,
        store,
        settings,
        out: line,
      });
    } finally {
      store.close();
    }
  },
};

const chatCommand: Command = {
  name: "chat",
  summary: "Hold a back-and-forth conversation — one line per turn, until EOF.",
  usage: "vesper voice chat [--cli <name>] [--silent]",
  async run({ flags }) {
    const { brain, provider, settings } = await resolveVoiceRuntime(flags);
    const store = openStore(dbPath());

    line(dim("type a message and press enter; Ctrl-D to exit"));
    try {
      for await (const chunk of console) {
        const transcript = String(chunk).trim();
        if (transcript.length === 0) continue;
        await runAsk({
          transcript,
          brain,
          provider,
          store,
          settings,
          out: (text) => line(`${cyan("vesper")} ${text}`),
        });
      }
    } finally {
      store.close();
    }
    return 0;
  },
};

const setupCommand: Command = {
  name: "setup",
  summary: "Prepare the local voice runtime (model directory + guidance).",
  usage: "vesper voice setup",
  run() {
    const settings = DEFAULT_VOICE_SETTINGS;
    const modelsDir = join(vesperHome(), "models");
    mkdirSync(modelsDir, { recursive: true });
    line(`models directory: ${cyan(modelsDir)}`);
    line(`default model:    ${cyan(settings.model)}`);
    line(
      dim(
        "speech-to-text (Whisper) + the global hotkey run in the native voice shell, landing in a follow-up.",
      ),
    );
    line(dim('text-to-speech + the brain work today — try `vesper voice ask "hello"`.'));
    return 0;
  },
};

const micTestCommand: Command = {
  name: "mic-test",
  summary: "Check the voice output path (mic capture ships with the native shell).",
  usage: "vesper voice mic-test",
  run() {
    line(
      dim(
        "microphone capture is part of the native voice shell (follow-up); checking output instead ...",
      ),
    );
    return runSay({ provider: localProvider(), text: "Vesper voice check.", out: line });
  },
};

/** `vesper voice ...` — talk to Vesper (local-first; your CLI is the brain). */
export const voiceGroup: CommandGroup = {
  name: "voice",
  summary: "Talk to Vesper — local speech in and out, your CLI as the brain.",
  subcommands: [sayCommand, askCommand, chatCommand, setupCommand, micTestCommand],
};

import { describe, expect, test } from "bun:test";
import { CommandNotFoundError, type ProcessRunner, type RunResult } from "../process/run.ts";
import { VoiceError } from "./errors.ts";
import { createVoiceProvider, LocalVoiceProvider } from "./provider.ts";

/** A runner that records its calls and returns a canned ok result. */
function recordingRunner(): { runner: ProcessRunner; calls: Array<[string, readonly string[]]> } {
  const calls: Array<[string, readonly string[]]> = [];
  const runner: ProcessRunner = async (command, args) => {
    calls.push([command, args]);
    return { stdout: "", stderr: "", exitCode: 0, durationMs: 1 } satisfies RunResult;
  };
  return { runner, calls };
}

describe("LocalVoiceProvider.speak", () => {
  test("runs the TTS command with the text as the final argument", async () => {
    const { runner, calls } = recordingRunner();
    const provider = new LocalVoiceProvider({
      runner,
      ttsCommand: "say",
      ttsArgs: ["-v", "Samantha"],
    });
    await provider.speak("Hello Omar");
    expect(calls).toEqual([["say", ["-v", "Samantha", "Hello Omar"]]]);
  });

  test("defaults to the macOS `say` command", async () => {
    const { runner, calls } = recordingRunner();
    await new LocalVoiceProvider({ runner }).speak("hi");
    expect(calls[0]?.[0]).toBe("say");
  });

  test("skips empty/whitespace text without invoking the runner", async () => {
    const { runner, calls } = recordingRunner();
    await new LocalVoiceProvider({ runner }).speak("   ");
    expect(calls).toEqual([]);
  });

  test("maps a missing TTS binary to VoiceError(tts_unavailable)", async () => {
    const runner: ProcessRunner = async () => {
      throw new CommandNotFoundError("say");
    };
    const err = await new LocalVoiceProvider({ runner }).speak("hi").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VoiceError);
    expect((err as VoiceError).reason).toBe("tts_unavailable");
  });

  test("maps a nonzero exit to VoiceError(tts_unavailable)", async () => {
    const runner: ProcessRunner = async () => ({
      stdout: "",
      stderr: "boom",
      exitCode: 1,
      durationMs: 1,
    });
    const err = await new LocalVoiceProvider({ runner }).speak("hi").catch((e: unknown) => e);
    expect((err as VoiceError).reason).toBe("tts_unavailable");
  });
});

describe("LocalVoiceProvider.transcribe", () => {
  test("rejects with stt_unavailable (local STT lives in the native shell)", async () => {
    const { runner } = recordingRunner();
    const err = await new LocalVoiceProvider({ runner }).transcribe("clip.wav").catch((e) => e);
    expect(err).toBeInstanceOf(VoiceError);
    expect((err as VoiceError).reason).toBe("stt_unavailable");
  });
});

describe("createVoiceProvider", () => {
  test("constructs the local provider", () => {
    const { runner } = recordingRunner();
    const provider = createVoiceProvider("local", { runner });
    expect(provider.id).toBe("local");
  });

  test("rejects the deferred elevenlabs backend with unknown_provider", () => {
    const { runner } = recordingRunner();
    expect(() => createVoiceProvider("elevenlabs", { runner })).toThrow(VoiceError);
  });
});

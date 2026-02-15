import { afterEach, describe, expect, test } from "bun:test";
import { AiService } from "../src/ai/AiService";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockEnv(overrides: Partial<Env> = {}): Env {
  return {
    CF_AI_GATEWAY_ACCOUNT_ID: "account-123",
    CF_AI_GATEWAY_ID: "openclaw-core",
    ...overrides,
  } as Env;
}

describe("AiService", () => {
  test("calls AI Gateway compat endpoint with BYOK/auth headers", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;

    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      capturedUrl = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      capturedInit = init;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "{\"ok\":true}" } }],
        }),
      );
    }) as typeof fetch;

    const service = new AiService(
      mockEnv({
        CF_AIG_AUTH_TOKEN: "aig-token",
        CF_AI_DEFAULT_MODEL: "anthropic/claude-opus-4-6",
      }),
    );

    const content = await service.generate("hello", "system", {
      byokAlias: "bot-alpha-anthropic",
      model: "openai/gpt-4.1-mini",
      temperature: 0.5,
      maxTokens: 700,
    });

    expect(content).toBe("{\"ok\":true}");
    expect(capturedUrl.startsWith("https://gateway.ai.cloudflare.com/v1/account-123/openclaw-core")).toBe(
      true,
    );
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get("cf-aig-authorization")).toBe("Bearer aig-token");
    expect(headers.get("cf-aig-byok-alias")).toBe("bot-alpha-anthropic");

    const rawBody = String(capturedInit?.body ?? "");
    expect(rawBody).toContain("openai/gpt-4.1-mini");
    expect(rawBody).toContain("hello");
    expect(rawBody).toContain("system");
  });

  test("extracts content when provider returns content blocks", async () => {
    globalThis.fetch = (async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: [
                  { text: "{\"action\":\"HOLD\"," },
                  { text: "\"pair\":\"ETH\"}" },
                ],
              },
            },
          ],
        }),
      )) as typeof fetch;

    const service = new AiService(mockEnv());
    const content = await service.generate("hello");
    expect(content).toContain("\"action\":\"HOLD\"");
    expect(content).toContain("\"pair\":\"ETH\"");
  });

  test("fails fast when gateway env is missing", async () => {
    const service = new AiService(
      {
        CF_AI_GATEWAY_ACCOUNT_ID: "",
        CF_AI_GATEWAY_ID: "",
      } as Env,
    );
    await expect(service.generate("hello")).rejects.toThrow(
      "Missing AI Gateway configuration",
    );
  });
});

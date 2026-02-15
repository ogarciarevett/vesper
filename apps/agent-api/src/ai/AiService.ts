import { generateText } from "ai";
import { createAiGateway } from "ai-gateway-provider";
import { createUnified } from "ai-gateway-provider/providers/unified";

const DEFAULT_MODEL = "anthropic/claude-opus-4-6";
const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_TEMPERATURE = 0.2;

type ChatCompletionMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?:
        | string
        | Array<{
            text?: string;
          }>;
    };
  }>;
};

export interface AiGenerateOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  byokAlias?: string;
}

export class AiService {
  constructor(private env: Env) {}

  async generate(
    prompt: string,
    systemPrompt?: string,
    options: AiGenerateOptions = {},
  ): Promise<string> {
    const gatewayId = this.env.CF_AI_GATEWAY_ID?.trim();
    const accountId = this.env.CF_AI_GATEWAY_ACCOUNT_ID?.trim();

    if (!gatewayId || !accountId) {
      throw new Error("Missing AI Gateway configuration");
    }

    const modelId = this.resolveModel(options.model);
    const maxOutputTokens = this.resolveMaxTokens(options.maxTokens);
    const temperature = this.resolveTemperature(options.temperature);
    const byokAlias = options.byokAlias?.trim();
    const gatewayToken = this.env.CF_AIG_AUTH_TOKEN?.trim();

    if (byokAlias) {
      return this.generateViaCompatFetch({
        accountId,
        gatewayId,
        gatewayToken,
        byokAlias,
        modelId,
        prompt,
        systemPrompt,
        maxOutputTokens,
        temperature,
      });
    }

    const aigateway = createAiGateway({
      accountId,
      gateway: gatewayId,
      ...(gatewayToken ? { apiKey: gatewayToken } : {}),
    });

    const unified = createUnified();

    try {
      const { text } = await generateText({
        model: aigateway(unified(modelId)),
        prompt,
        system: systemPrompt?.trim() ? systemPrompt : undefined,
        maxOutputTokens,
        temperature,
      });

      const content = typeof text === "string" ? text.trim() : "";
      if (!content) {
        throw new Error("AI Gateway returned an empty completion");
      }
      return content;
    } catch {
      // Fallback for provider-specific compat responses that can fail strict SDK parsing.
      return this.generateViaCompatFetch({
        accountId,
        gatewayId,
        gatewayToken,
        byokAlias,
        modelId,
        prompt,
        systemPrompt,
        maxOutputTokens,
        temperature,
      });
    }
  }

  private resolveModel(model?: string): string {
    if (typeof model === "string" && model.trim().length > 0) {
      return model.trim();
    }
    if (this.env.CF_AI_DEFAULT_MODEL?.trim()) {
      return this.env.CF_AI_DEFAULT_MODEL.trim();
    }
    return DEFAULT_MODEL;
  }

  private resolveMaxTokens(maxTokens?: number): number {
    if (typeof maxTokens === "number" && Number.isFinite(maxTokens)) {
      return Math.max(1, Math.floor(maxTokens));
    }
    return DEFAULT_MAX_TOKENS;
  }

  private resolveTemperature(temperature?: number): number {
    if (typeof temperature === "number" && Number.isFinite(temperature)) {
      return Math.min(2, Math.max(0, temperature));
    }
    return DEFAULT_TEMPERATURE;
  }

  private async generateViaCompatFetch(input: {
    accountId: string;
    gatewayId: string;
    gatewayToken?: string;
    byokAlias?: string;
    modelId: string;
    prompt: string;
    systemPrompt?: string;
    maxOutputTokens: number;
    temperature: number;
  }): Promise<string> {
    const url =
      `https://gateway.ai.cloudflare.com/v1/${input.accountId}/${input.gatewayId}` +
      "/compat/chat/completions";

    const headers = new Headers({
      "Content-Type": "application/json",
    });
    if (input.gatewayToken) {
      headers.set("cf-aig-authorization", `Bearer ${input.gatewayToken}`);
    }
    if (input.byokAlias) {
      headers.set("cf-aig-byok-alias", input.byokAlias);
    }

    const messages: ChatCompletionMessage[] = [];
    if (input.systemPrompt && input.systemPrompt.trim().length > 0) {
      messages.push({ role: "system", content: input.systemPrompt });
    }
    messages.push({ role: "user", content: input.prompt });

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: input.modelId,
        max_tokens: input.maxOutputTokens,
        temperature: input.temperature,
        messages,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`AI Gateway error: ${response.status} ${text}`);
    }

    const data = (await response.json()) as ChatCompletionResponse;
    const content = this.extractMessageContent(data);
    if (!content) {
      throw new Error("AI Gateway returned an empty completion");
    }
    return content;
  }

  private extractMessageContent(data: ChatCompletionResponse): string | null {
    const choice = Array.isArray(data.choices) ? data.choices[0] : undefined;
    const content = choice?.message?.content;
    if (typeof content === "string" && content.length > 0) {
      return content;
    }
    if (Array.isArray(content)) {
      const joined = content
        .map((part) => part.text)
        .filter((text): text is string => typeof text === "string")
        .join("\n")
        .trim();
      if (joined.length > 0) {
        return joined;
      }
    }
    return null;
  }
}

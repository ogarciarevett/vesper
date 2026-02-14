export class AiService {
  constructor(private env: Env) {}

  async generate(prompt: string, systemPrompt?: string): Promise<string> {
    const gatewayId = this.env.CF_AI_GATEWAY_GATEWAY_ID;
    const accountId = this.env.CF_AI_GATEWAY_ACCOUNT_ID;
    const apiKey = this.env.CLOUDFLARE_AI_GATEWAY_API_KEY;

    if (!gatewayId || !accountId || !apiKey) {
      throw new Error("Missing AI Gateway configuration");
    }

    const url = `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/anthropic/v1/messages`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-3-5-sonnet-20240620",
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`AI Gateway error: ${response.status} ${text}`);
    }

    const data: any = await response.json();
    return data.content[0].text;
  }
}

interface Env {
  AGENT_API_URL?: string;
  OPENCLAW_GATEWAY_PASSWORD?: string;
}

function json(status: number, payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const agentApiUrl = env.AGENT_API_URL;
  const gatewayPassword = env.OPENCLAW_GATEWAY_PASSWORD;

  if (!agentApiUrl || !gatewayPassword) {
    return json(503, {
      ok: false,
      error: "BFF_MISCONFIGURED",
      message:
        "Missing AGENT_API_URL or OPENCLAW_GATEWAY_PASSWORD in agent-dashboard Functions environment",
    });
  }

  const incoming = new URL(request.url);
  const target = new URL(agentApiUrl);
  target.pathname = incoming.pathname;
  target.search = incoming.search;

  // Clone incoming request (method/body/upgrade) and inject gateway auth server-side.
  const proxiedRequest = new Request(target.toString(), request);
  const headers = new Headers(proxiedRequest.headers);
  headers.set("x-openclaw-gateway-password", gatewayPassword);
  headers.delete("host");

  const forwarded = new Request(proxiedRequest, { headers });
  return fetch(forwarded);
};

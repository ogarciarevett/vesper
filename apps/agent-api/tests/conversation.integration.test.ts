import { describe, expect, test } from "bun:test";

const baseUrl = process.env.OPENCLAW_INTEGRATION_BASE_URL;
const gatewayPassword = process.env.OPENCLAW_GATEWAY_PASSWORD;

async function fetchJson<T>(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; data: T }> {
  if (!baseUrl) {
    throw new Error("OPENCLAW_INTEGRATION_BASE_URL is required");
  }

  const headers = new Headers(init.headers);
  if (gatewayPassword) {
    headers.set("x-openclaw-gateway-password", gatewayPassword);
  }
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers,
  });
  return {
    status: response.status,
    data: (await response.json()) as T,
  };
}

describe.skipIf(!baseUrl || !gatewayPassword)(
  "Conversation API Integration",
  () => {
    const ROOM_ID = "integration-test-room";

    test("POST /api/room/:id/message creates a message", async () => {
      const { status, data } = await fetchJson<{
        ok: boolean;
        messageId: string;
      }>(`/api/room/${ROOM_ID}/message`, {
        method: "POST",
        body: JSON.stringify({
          fromAgentId: "test-bot-alpha",
          content: "Integration test message",
          messageType: "THOUGHT",
        }),
      });

      expect(status).toBe(200);
      expect(data.ok).toBe(true);
      expect(typeof data.messageId).toBe("string");
      expect(data.messageId.length).toBeGreaterThan(0);
    });

    test("GET /api/room/:id/messages returns recent messages", async () => {
      // Post a message first
      await fetchJson(`/api/room/${ROOM_ID}/message`, {
        method: "POST",
        body: JSON.stringify({
          fromAgentId: "test-bot-beta",
          content: "Another integration test message",
          messageType: "ANALYSIS",
        }),
      });

      const { status, data } = await fetchJson<{
        ok: boolean;
        messages: Array<{
          messageId: string;
          fromAgentId: string;
          content: string;
          messageType: string;
        }>;
      }>(`/api/room/${ROOM_ID}/messages?limit=10`);

      expect(status).toBe(200);
      expect(data.ok).toBe(true);
      expect(Array.isArray(data.messages)).toBe(true);
      expect(data.messages.length).toBeGreaterThan(0);

      const lastMsg = data.messages[data.messages.length - 1]!;
      expect(lastMsg.fromAgentId).toBe("test-bot-beta");
      expect(lastMsg.content).toBe("Another integration test message");
      expect(lastMsg.messageType).toBe("ANALYSIS");
    });

    test("POST /api/room/:id/message rejects missing fields", async () => {
      const { status, data } = await fetchJson<{
        ok: boolean;
        message: string;
      }>(`/api/room/${ROOM_ID}/message`, {
        method: "POST",
        body: JSON.stringify({
          content: "Missing fromAgentId",
        }),
      });

      expect(status).toBe(400);
      expect(data.ok).toBe(false);
    });

    test("messages support directed and reply fields", async () => {
      const { data: proposalData } = await fetchJson<{
        ok: boolean;
        messageId: string;
      }>(`/api/room/${ROOM_ID}/message`, {
        method: "POST",
        body: JSON.stringify({
          fromAgentId: "test-bot-alpha",
          toAgentId: "test-bot-beta",
          content: "Proposing long on ETH",
          messageType: "PROPOSAL",
        }),
      });

      expect(proposalData.ok).toBe(true);

      const { data: reviewData } = await fetchJson<{
        ok: boolean;
        messageId: string;
      }>(`/api/room/${ROOM_ID}/message`, {
        method: "POST",
        body: JSON.stringify({
          fromAgentId: "test-bot-beta",
          toAgentId: "test-bot-alpha",
          content: "I agree, momentum is bullish",
          messageType: "AGREEMENT",
          replyToMessageId: proposalData.messageId,
        }),
      });

      expect(reviewData.ok).toBe(true);

      // Verify both messages appear in history
      const { data: historyData } = await fetchJson<{
        ok: boolean;
        messages: Array<{
          messageId: string;
          toAgentId: string | null;
          replyToMessageId: string | null;
        }>;
      }>(`/api/room/${ROOM_ID}/messages?limit=10`);

      const proposal = historyData.messages.find(
        (m) => m.messageId === proposalData.messageId,
      );
      const review = historyData.messages.find(
        (m) => m.messageId === reviewData.messageId,
      );

      expect(proposal).toBeDefined();
      expect(proposal?.toAgentId).toBe("test-bot-beta");
      expect(review).toBeDefined();
      expect(review?.replyToMessageId).toBe(proposalData.messageId);
    });
  },
);

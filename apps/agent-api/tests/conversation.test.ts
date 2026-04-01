import { describe, expect, test } from "bun:test";
import type { AgentConversationMessage, AgentMessagePayload, AgentMessageType } from "@repo/types";

describe("Conversation Types", () => {
	test("AgentMessagePayload can be constructed with all fields", () => {
		const payload: AgentMessagePayload = {
			messageId: "msg-001",
			fromAgentId: "bot-alpha",
			toAgentId: null,
			content: "Analyzing ETH market conditions",
			messageType: "ANALYSIS",
			replyToMessageId: null,
			timestamp: new Date().toISOString(),
		};

		expect(payload.messageId).toBe("msg-001");
		expect(payload.fromAgentId).toBe("bot-alpha");
		expect(payload.toAgentId).toBeNull();
		expect(payload.content).toBe("Analyzing ETH market conditions");
		expect(payload.messageType).toBe("ANALYSIS");
	});

	test("AgentMessagePayload supports directed messages", () => {
		const payload: AgentMessagePayload = {
			messageId: "msg-002",
			fromAgentId: "bot-alpha",
			toAgentId: "bot-beta",
			content: "I propose we go long on ETH",
			messageType: "PROPOSAL",
			replyToMessageId: null,
			timestamp: new Date().toISOString(),
		};

		expect(payload.toAgentId).toBe("bot-beta");
		expect(payload.messageType).toBe("PROPOSAL");
	});

	test("AgentMessagePayload supports reply chains", () => {
		const proposal: AgentMessagePayload = {
			messageId: "msg-003",
			fromAgentId: "bot-alpha",
			toAgentId: null,
			content: "Proposing long on ETH at $3500",
			messageType: "PROPOSAL",
			replyToMessageId: null,
			timestamp: new Date().toISOString(),
		};

		const review: AgentMessagePayload = {
			messageId: "msg-004",
			fromAgentId: "bot-beta",
			toAgentId: "bot-alpha",
			content: "I agree, momentum is strong",
			messageType: "AGREEMENT",
			replyToMessageId: proposal.messageId,
			timestamp: new Date().toISOString(),
		};

		expect(review.replyToMessageId).toBe("msg-003");
		expect(review.messageType).toBe("AGREEMENT");
	});

	test("AgentConversationMessage wraps payload with room context", () => {
		const msg: AgentConversationMessage = {
			type: "AGENT_MESSAGE",
			roomId: "trading-room-alpha",
			payload: {
				messageId: "msg-005",
				fromAgentId: "bot-alpha",
				toAgentId: null,
				content: "Market data fetched successfully",
				messageType: "STATUS_UPDATE",
				replyToMessageId: null,
				timestamp: new Date().toISOString(),
			},
		};

		expect(msg.type).toBe("AGENT_MESSAGE");
		expect(msg.roomId).toBe("trading-room-alpha");
		expect(msg.payload.fromAgentId).toBe("bot-alpha");
	});

	test("all AgentMessageType values are valid", () => {
		const validTypes: AgentMessageType[] = [
			"THOUGHT",
			"ANALYSIS",
			"PROPOSAL",
			"REVIEW",
			"AGREEMENT",
			"DISAGREEMENT",
			"STATUS_UPDATE",
		];

		expect(validTypes).toHaveLength(7);
		for (const t of validTypes) {
			expect(typeof t).toBe("string");
		}
	});
});

describe("Message Ring Buffer Logic", () => {
	const MAX_MESSAGES = 100;

	function createMessage(
		id: string,
		fromAgentId: string,
		content: string,
		messageType: AgentMessageType = "THOUGHT",
	): AgentMessagePayload {
		return {
			messageId: id,
			fromAgentId,
			toAgentId: null,
			content,
			messageType,
			replyToMessageId: null,
			timestamp: new Date().toISOString(),
		};
	}

	test("ring buffer keeps last N messages", () => {
		let messages: AgentMessagePayload[] = [];

		// Add 150 messages
		for (let i = 0; i < 150; i++) {
			messages.push(createMessage(`msg-${i}`, "bot-alpha", `Message ${i}`));
			if (messages.length > MAX_MESSAGES) {
				messages = messages.slice(-MAX_MESSAGES);
			}
		}

		expect(messages).toHaveLength(MAX_MESSAGES);
		expect(messages[0]!.messageId).toBe("msg-50");
		expect(messages[messages.length - 1]!.messageId).toBe("msg-149");
	});

	test("ring buffer preserves order", () => {
		let messages: AgentMessagePayload[] = [];

		messages.push(createMessage("msg-1", "bot-alpha", "First"));
		messages.push(createMessage("msg-2", "bot-beta", "Second"));
		messages.push(createMessage("msg-3", "bot-alpha", "Third"));

		if (messages.length > MAX_MESSAGES) {
			messages = messages.slice(-MAX_MESSAGES);
		}

		expect(messages).toHaveLength(3);
		expect(messages[0]!.messageId).toBe("msg-1");
		expect(messages[2]!.messageId).toBe("msg-3");
	});

	test("ring buffer handles empty state", () => {
		const messages: AgentMessagePayload[] = [];
		const limit = 50;
		const result = messages.slice(-limit);
		expect(result).toHaveLength(0);
	});

	test("limit parameter caps returned messages", () => {
		const messages: AgentMessagePayload[] = [];

		for (let i = 0; i < 80; i++) {
			messages.push(createMessage(`msg-${i}`, "bot-alpha", `Message ${i}`));
		}

		const limit = 20;
		const result = messages.slice(-limit);
		expect(result).toHaveLength(20);
		expect(result[0]!.messageId).toBe("msg-60");
	});
});

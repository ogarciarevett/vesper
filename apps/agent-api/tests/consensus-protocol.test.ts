import { describe, expect, test } from "bun:test";
import { processProposalVote } from "../src/consensus/index";
import type { ProposalState } from "@repo/types";

function createProposal(fromAgentId = "bot-alpha"): ProposalState {
  return {
    proposal: {
      proposalId: "prop-001",
      action: "OPEN_LONG",
      pair: "ETH",
      rationale: "Strong momentum signal",
      confidence: 75,
      data: {},
    },
    fromAgentId,
    approvals: [],
    rejections: [],
    status: "PENDING",
    createdAt: new Date().toISOString(),
    resolvedAt: null,
  };
}

describe("Consensus Protocol", () => {
  test("approves proposal when threshold is met", () => {
    const proposal = createProposal();
    processProposalVote(proposal, "bot-beta", true, 2);
    expect(proposal.status).toBe("PENDING");
    expect(proposal.approvals).toEqual(["bot-beta"]);

    const result = processProposalVote(proposal, "bot-gamma", true, 2);
    expect(result.changed).toBe(true);
    expect(result.newStatus).toBe("APPROVED");
    expect(proposal.status).toBe("APPROVED");
    expect(proposal.resolvedAt).not.toBeNull();
  });

  test("rejects proposal when rejection threshold is met", () => {
    const proposal = createProposal();
    processProposalVote(proposal, "bot-beta", false, 2);
    const result = processProposalVote(proposal, "bot-gamma", false, 2);
    expect(result.changed).toBe(true);
    expect(result.newStatus).toBe("REJECTED");
    expect(proposal.rejections).toEqual(["bot-beta", "bot-gamma"]);
  });

  test("prevents double-voting", () => {
    const proposal = createProposal();
    processProposalVote(proposal, "bot-beta", true, 2);
    const result = processProposalVote(proposal, "bot-beta", true, 2);
    expect(result.changed).toBe(false);
    expect(proposal.approvals).toEqual(["bot-beta"]);
  });

  test("prevents self-voting", () => {
    const proposal = createProposal("bot-alpha");
    const result = processProposalVote(proposal, "bot-alpha", true, 2);
    expect(result.changed).toBe(false);
    expect(proposal.approvals).toEqual([]);
  });

  test("threshold of 1 means single approval suffices", () => {
    const proposal = createProposal();
    const result = processProposalVote(proposal, "bot-beta", true, 1);
    expect(result.changed).toBe(true);
    expect(result.newStatus).toBe("APPROVED");
  });

  test("ignores votes on already-resolved proposals", () => {
    const proposal = createProposal();
    proposal.status = "APPROVED";
    const result = processProposalVote(proposal, "bot-beta", false, 2);
    expect(result.changed).toBe(false);
    expect(proposal.rejections).toEqual([]);
  });

  test("mixed votes: approval wins when threshold reached first", () => {
    const proposal = createProposal();
    processProposalVote(proposal, "bot-beta", false, 2);
    processProposalVote(proposal, "bot-gamma", true, 2);
    expect(proposal.status).toBe("PENDING");

    processProposalVote(proposal, "bot-delta", true, 2);
    expect(proposal.status).toBe("APPROVED");
    expect(proposal.approvals).toEqual(["bot-gamma", "bot-delta"]);
    expect(proposal.rejections).toEqual(["bot-beta"]);
  });
});

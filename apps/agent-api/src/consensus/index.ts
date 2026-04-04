import type { ProposalState } from "@repo/types";

/**
 * Process a vote on a proposal. Returns whether the proposal's status changed.
 * Pure function extracted from TradingRoom for testability.
 */
export function processProposalVote(
  proposal: ProposalState,
  voterId: string,
  isApproval: boolean,
  consensusThreshold: number,
): { changed: boolean; newStatus: ProposalState["status"] } {
  if (proposal.status !== "PENDING") {
    return { changed: false, newStatus: proposal.status };
  }

  // Prevent double-voting
  if (proposal.approvals.includes(voterId) || proposal.rejections.includes(voterId)) {
    return { changed: false, newStatus: proposal.status };
  }

  // Prevent self-voting
  if (proposal.fromAgentId === voterId) {
    return { changed: false, newStatus: proposal.status };
  }

  if (isApproval) {
    proposal.approvals.push(voterId);
  } else {
    proposal.rejections.push(voterId);
  }

  // Check consensus
  if (proposal.approvals.length >= consensusThreshold) {
    proposal.status = "APPROVED";
    proposal.resolvedAt = new Date().toISOString();
    return { changed: true, newStatus: "APPROVED" };
  }

  if (proposal.rejections.length >= consensusThreshold) {
    proposal.status = "REJECTED";
    proposal.resolvedAt = new Date().toISOString();
    return { changed: true, newStatus: "REJECTED" };
  }

  return { changed: false, newStatus: "PENDING" };
}

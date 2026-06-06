/// <reference lib="dom" />

import type { SweDiffLine, SweDiffView, SweFileDiff } from "../../world/types.ts";
import { ApiError } from "../shell/api.ts";
import { h, injectStyle, type SectionContext } from "../shell/section.ts";

const DIFF_REVIEW_CSS = `
  .dr-scrim { position: fixed; inset: 0; z-index: 900; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; padding: 20px; }
  .dr-panel { position: relative; width: 100%; max-width: 960px; max-height: 85vh; display: flex; flex-direction: column; background: var(--surface-2); border: 1px solid var(--border); border-radius: 18px; box-shadow: 0 36px 80px rgba(0,0,0,0.55); overflow: hidden; -webkit-backdrop-filter: var(--blur); backdrop-filter: var(--blur); }
  .dr-header { flex: none; display: flex; align-items: flex-start; gap: 12px; padding: 18px 20px 14px; border-bottom: 1px solid var(--border); }
  .dr-header-main { flex: 1; min-width: 0; }
  .dr-title { font-size: 17px; font-weight: 700; color: var(--ink); margin: 0; }
  .dr-change-id { display: block; font-size: 11.5px; font-family: ui-monospace, monospace; color: var(--ink-soft); margin-top: 3px; }
  .dr-summary { font-size: 13px; color: var(--ink-soft); margin-top: 5px; }
  .dr-summary .dr-add { color: var(--ok); font-weight: 600; }
  .dr-summary .dr-del { color: var(--danger); font-weight: 600; }
  .dr-close { flex: none; width: 28px; height: 28px; display: grid; place-items: center; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-strong); color: var(--ink-soft); font-size: 16px; line-height: 1; cursor: pointer; }
  .dr-close:hover { color: var(--ink); }
  .dr-body { flex: 1; min-height: 0; overflow-y: auto; padding: 14px 18px; display: flex; flex-direction: column; gap: 10px; }
  .dr-state { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 40px 20px; color: var(--ink-soft); font-size: 14px; text-align: center; }
  .dr-spin { width: 22px; height: 22px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: dr-spin 0.7s linear infinite; flex: none; }
  @keyframes dr-spin { to { transform: rotate(360deg); } }
  .dr-retry { padding: 6px 16px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-strong); color: var(--ink); font: inherit; font-size: 13px; cursor: pointer; }
  .dr-retry:hover { background: var(--surface-2); }
  .dr-file { border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
  .dr-file-head { display: flex; align-items: center; gap: 9px; padding: 9px 13px; background: var(--surface-strong); cursor: pointer; user-select: none; }
  .dr-file-head:hover { background: var(--surface-2); }
  .dr-file-badge { font-size: 10px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; padding: 2px 7px; border-radius: 4px; flex: none; }
  .dr-file-badge.added    { background: rgba(58,208,127,0.18); color: var(--ok); }
  .dr-file-badge.deleted  { background: rgba(255,107,139,0.18); color: var(--danger); }
  .dr-file-badge.modified { background: rgba(124,92,255,0.18); color: var(--accent); }
  .dr-file-badge.renamed  { background: rgba(154,125,255,0.18); color: var(--accent-2); }
  .dr-file-path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, monospace; font-size: 13px; color: var(--ink); }
  .dr-file-counts { flex: none; display: flex; gap: 6px; font-size: 12px; }
  .dr-file-counts .dr-add { color: var(--ok); font-weight: 600; }
  .dr-file-counts .dr-del { color: var(--danger); font-weight: 600; }
  .dr-file-toggle { flex: none; font-size: 11px; color: var(--ink-faint); }
  .dr-file-body { overflow-x: auto; }
  .dr-file-body.collapsed { display: none; }
  .dr-binary { padding: 14px 16px; font-size: 13px; color: var(--ink-soft); font-style: italic; }
  .dr-diff-table { width: 100%; border-collapse: collapse; font-family: ui-monospace, monospace; font-size: 12.5px; line-height: 1.5; }
  .dr-diff-table td { padding: 1px 6px; vertical-align: top; }
  .dr-ln { width: 44px; min-width: 36px; text-align: right; color: var(--ink-faint); user-select: none; font-variant-numeric: tabular-nums; border-right: 1px solid var(--border); padding-right: 8px; }
  .dr-marker { width: 18px; text-align: center; user-select: none; font-variant-numeric: tabular-nums; }
  .dr-content { white-space: pre; color: var(--ink); }
  .dr-hunk-head td { background: rgba(124,92,255,0.08); color: var(--ink-soft); font-size: 12px; padding: 3px 10px; }
  .dr-insert td { background: rgba(58,208,127,0.1); }
  .dr-insert .dr-marker { color: var(--ok); }
  .dr-delete td { background: rgba(255,107,139,0.1); }
  .dr-delete .dr-marker { color: var(--danger); }
  .dr-footer { flex: none; border-top: 1px solid var(--border); padding: 12px 18px; display: flex; flex-direction: column; gap: 8px; background: var(--surface-strong); }
  .dr-footer-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .dr-code-input { flex: 1; min-width: 180px; padding: 7px 12px; border: 1px solid var(--border); border-radius: 9px; background: var(--surface-2); color: var(--ink); font: inherit; font-size: 13px; }
  .dr-code-input::placeholder { color: var(--ink-faint); }
  .dr-code-input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .dr-reason-row { display: flex; align-items: center; gap: 8px; }
  .dr-reason-input { flex: 1; padding: 7px 12px; border: 1px solid var(--border); border-radius: 9px; background: var(--surface-2); color: var(--ink); font: inherit; font-size: 13px; }
  .dr-reason-input::placeholder { color: var(--ink-faint); }
  .dr-reason-input:focus-visible { outline: 2px solid var(--danger); outline-offset: 1px; }
  .dr-btn { padding: 7px 16px; border-radius: 9px; border: 1px solid var(--border); font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
  .dr-btn:disabled { opacity: 0.5; cursor: default; }
  .dr-btn.request { background: var(--surface-2); color: var(--ink); }
  .dr-btn.request:hover:not(:disabled) { background: var(--surface-strong); }
  .dr-btn.approve { background: var(--ok); color: #0e1a13; border-color: var(--ok); }
  .dr-btn.approve:hover:not(:disabled) { opacity: 0.85; }
  .dr-btn.reject { background: var(--danger); color: #1a0a0e; border-color: var(--danger); }
  .dr-btn.reject:hover:not(:disabled) { opacity: 0.85; }
`;

/** Options for opening the diff-review modal. */
export interface DiffReviewOptions {
  readonly runId: string;
  readonly changeId: string;
}

/**
 * Open the GitHub-PR-style diff review modal over the current page.
 * Fetches `GET /api/runs/:runId/diff?changeId=<changeId>`, renders a
 * unified diff per file, and provides an approval-code gated Approve/Reject footer.
 * The modal is self-contained: close via the X button, backdrop click, or Escape.
 */
export function openDiffReview(ctx: SectionContext, opts: DiffReviewOptions): void {
  injectStyle("diff-review-css", DIFF_REVIEW_CSS);

  const closeBtn = h("button", { type: "button", class: "dr-close", "aria-label": "Close" }, "×");
  const headerMain = h(
    "div",
    { class: "dr-header-main" },
    h("div", { class: "dr-title" }, "Review change"),
    h("code", { class: "dr-change-id" }, opts.changeId),
  );
  const body = h("div", { class: "dr-body" });
  const footer = buildFooter(ctx, opts, () => close());

  const panel = h(
    "div",
    { class: "dr-panel", role: "dialog", "aria-modal": "true", "aria-label": "Review change" },
    h("div", { class: "dr-header" }, headerMain, closeBtn),
    body,
    footer,
  );
  const scrim = h("div", { class: "dr-scrim" }, panel);
  document.body.append(scrim);

  function close(): void {
    document.removeEventListener("keydown", onEsc);
    scrim.remove();
  }

  function onEsc(e: KeyboardEvent): void {
    if (e.key === "Escape") close();
  }

  document.addEventListener("keydown", onEsc);
  scrim.addEventListener("click", (e) => {
    if (e.target === scrim) close();
  });
  closeBtn.addEventListener("click", close);

  renderLoading(body);
  void loadDiff(ctx, opts, body, headerMain);
}

// ---------------------------------------------------------------------------
// Internal rendering helpers
// ---------------------------------------------------------------------------

function renderLoading(body: HTMLElement): void {
  body.replaceChildren(
    h("div", { class: "dr-state" }, h("div", { class: "dr-spin" }), "Loading diff..."),
  );
}

async function loadDiff(
  ctx: SectionContext,
  opts: DiffReviewOptions,
  body: HTMLElement,
  headerMain: HTMLElement,
): Promise<void> {
  try {
    const diff = await ctx.api.getJson<SweDiffView>(
      `/api/runs/${encodeURIComponent(opts.runId)}/diff?changeId=${encodeURIComponent(opts.changeId)}`,
    );
    const fileLabel = diff.fileCount === 1 ? "1 file" : `${diff.fileCount} files`;
    headerMain.append(
      h(
        "div",
        { class: "dr-summary" },
        `${fileLabel} — `,
        h("span", { class: "dr-add" }, `+${diff.additions}`),
        " ",
        h("span", { class: "dr-del" }, `-${diff.deletions}`),
      ),
    );
    if (diff.files.length === 0) {
      body.replaceChildren(h("div", { class: "dr-state" }, "No files in this diff."));
    } else {
      body.replaceChildren(...diff.files.map(buildFileCard));
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to load diff";
    ctx.toast(msg);
    const retryBtn = h("button", { type: "button", class: "dr-retry" }, "Retry");
    retryBtn.addEventListener("click", () => {
      renderLoading(body);
      void loadDiff(ctx, opts, body, headerMain);
    });
    body.replaceChildren(h("div", { class: "dr-state" }, msg, retryBtn));
  }
}

function buildFileCard(file: SweFileDiff): HTMLElement {
  let collapsed = false;

  const pathText =
    file.status === "renamed" && file.oldPath !== null
      ? `${file.oldPath} → ${file.path}`
      : file.path;

  const badge = h("span", { class: `dr-file-badge ${file.status}` }, file.status);
  const pathEl = h("span", { class: "dr-file-path" });
  pathEl.textContent = pathText; // textContent — never innerHTML

  const counts = h(
    "span",
    { class: "dr-file-counts" },
    h("span", { class: "dr-add" }, `+${file.additions}`),
    " ",
    h("span", { class: "dr-del" }, `-${file.deletions}`),
  );
  const toggle = h("span", { class: "dr-file-toggle" }, "▾");
  const fileHead = h("div", { class: "dr-file-head" }, badge, pathEl, counts, toggle);

  const content: Node = file.binary
    ? h("div", { class: "dr-binary" }, "Binary file not shown.")
    : buildDiffTable(file);

  const fileBody = h("div", { class: "dr-file-body" }, content);

  fileHead.addEventListener("click", () => {
    collapsed = !collapsed;
    fileBody.classList.toggle("collapsed", collapsed);
    toggle.textContent = collapsed ? "▸" : "▾";
  });

  return h("div", { class: "dr-file" }, fileHead, fileBody);
}

function buildDiffTable(file: SweFileDiff): HTMLTableElement {
  const table = document.createElement("table");
  table.className = "dr-diff-table";
  const tbody = document.createElement("tbody");

  for (const hunk of file.hunks) {
    const hunkRow = document.createElement("tr");
    hunkRow.className = "dr-hunk-head";
    const cell = document.createElement("td");
    cell.colSpan = 4;
    cell.textContent = hunk.header; // textContent — never innerHTML
    hunkRow.append(cell);
    tbody.append(hunkRow);
    for (const line of hunk.lines) tbody.append(buildDiffLine(line));
  }

  table.append(tbody);
  return table;
}

function buildDiffLine(line: SweDiffLine): HTMLTableRowElement {
  const tr = document.createElement("tr");
  if (line.kind === "insert") tr.className = "dr-insert";
  else if (line.kind === "delete") tr.className = "dr-delete";

  const oldLn = document.createElement("td");
  oldLn.className = "dr-ln";
  oldLn.textContent = line.oldLine !== null ? String(line.oldLine) : "";

  const newLn = document.createElement("td");
  newLn.className = "dr-ln";
  newLn.textContent = line.newLine !== null ? String(line.newLine) : "";

  const marker = document.createElement("td");
  marker.className = "dr-marker";
  marker.textContent = line.kind === "insert" ? "+" : line.kind === "delete" ? "-" : " ";

  const content = document.createElement("td");
  content.className = "dr-content";
  content.textContent = line.content; // textContent — never innerHTML; white-space:pre preserves leading spaces

  tr.append(oldLn, newLn, marker, content);
  return tr;
}

function buildFooter(
  ctx: SectionContext,
  opts: DiffReviewOptions,
  closeModal: () => void,
): HTMLElement {
  let inFlight = false;

  const codeInput = h("input", {
    type: "text",
    class: "dr-code-input",
    placeholder: "approval code from the Vesper terminal",
    "aria-label": "Approval code",
    autocomplete: "off",
  });

  const reasonInput = h("input", {
    type: "text",
    class: "dr-reason-input",
    placeholder: "Optional reason for rejection",
    "aria-label": "Rejection reason",
  });

  const requestBtn = h("button", { type: "button", class: "dr-btn request" }, "Request code");
  const approveBtn = h("button", { type: "button", class: "dr-btn approve" }, "Approve");
  const rejectBtn = h("button", { type: "button", class: "dr-btn reject" }, "Reject");
  const confirmRejectBtn = h(
    "button",
    { type: "button", class: "dr-btn reject" },
    "Confirm reject",
  );

  const reasonRow = h("div", { class: "dr-reason-row" }, reasonInput, confirmRejectBtn);
  reasonRow.style.display = "none";

  function setDisabled(disabled: boolean): void {
    requestBtn.disabled = disabled;
    approveBtn.disabled = disabled;
    rejectBtn.disabled = disabled;
    confirmRejectBtn.disabled = disabled;
  }

  requestBtn.addEventListener("click", () => {
    if (inFlight) return;
    inFlight = true;
    setDisabled(true);
    ctx.api
      .postJson<unknown>("/api/approval/request")
      .then(() => {
        ctx.toast("A code was printed in the Vesper daemon terminal — paste it here");
        codeInput.focus();
      })
      .catch((err: unknown) => {
        ctx.toast(err instanceof Error ? err.message : "Failed to request code");
      })
      .finally(() => {
        inFlight = false;
        setDisabled(false);
      });
  });

  rejectBtn.addEventListener("click", () => {
    const visible = reasonRow.style.display !== "none";
    reasonRow.style.display = visible ? "none" : "";
    if (!visible) reasonInput.focus();
  });

  approveBtn.addEventListener("click", () => {
    void decide("approve", undefined);
  });

  confirmRejectBtn.addEventListener("click", () => {
    const reason = reasonInput.value.trim();
    void decide("reject", reason.length > 0 ? reason : undefined);
  });

  async function decide(decision: "approve" | "reject", reason: string | undefined): Promise<void> {
    const code = codeInput.value.trim();
    if (code.length === 0) {
      ctx.toast("Enter the approval code first");
      return;
    }
    if (inFlight) return;
    inFlight = true;
    setDisabled(true);
    try {
      const body: Record<string, string> = { decision };
      if (reason !== undefined) body.reason = reason;
      await ctx.api.postJson<unknown>(
        `/api/runs/${encodeURIComponent(opts.runId)}/changes/${encodeURIComponent(opts.changeId)}/decision`,
        body,
        { "x-vesper-approval": code },
      );
      ctx.toast(`Change ${decision === "approve" ? "approved" : "rejected"}`);
      closeModal();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        if (err.status === 401 || err.status === 403) {
          ctx.toast("Approval code missing, invalid, or expired");
        } else if (err.status === 409) {
          ctx.toast("This change is no longer awaiting a decision");
          closeModal();
        } else {
          ctx.toast(err.message);
        }
      } else {
        ctx.toast(err instanceof Error ? err.message : "Request failed");
      }
    } finally {
      inFlight = false;
      setDisabled(false);
    }
  }

  return h(
    "div",
    { class: "dr-footer" },
    h("div", { class: "dr-footer-row" }, codeInput, requestBtn, approveBtn, rejectBtn),
    reasonRow,
  );
}

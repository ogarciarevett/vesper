/// <reference lib="dom" />
import type { Inhabitant, RunEventInfo, RunTreeInfo, SceneGraph } from "../world/types.ts";
import { resolveMark } from "./brand/index.ts";
import { ChatHome } from "./chat.ts";
import type { HitRegion } from "./render.ts";
import { drawSprite, SPRITE_W, spriteFor } from "./sprite.ts";
import { TemplatesScreen } from "./templates.ts";
import { resolveTheme } from "./theme/registry.ts";
import {
  pickThemeId,
  readServerDefaultTheme,
  readStoredTheme,
  readUrlTheme,
  storeTheme,
} from "./theme-store.ts";
import "./themes/index.ts"; // registers the built-in themes (glass = default)

// Resolve the active renderer: URL ?theme= > the user's stored choice > the daemon's
// configured default (<meta name="vesper-theme">) > the registry default. A ?theme=
// visit is remembered. Unknown ids fall back in resolveTheme (never throws).
const urlTheme = readUrlTheme(window.location.search);
if (urlTheme !== null) storeTheme(urlTheme);
const activeTheme = resolveTheme(
  pickThemeId({
    url: urlTheme,
    stored: readStoredTheme(),
    serverDefault: readServerDefaultTheme(),
  }),
);
// Drive the DOM chrome palette (header, cards, toast) off the active theme.
document.body.dataset.theme = activeTheme.id;

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`missing #${id}`);
  return node as T;
}

const canvas = el<HTMLCanvasElement>("scene");
const ctx2d = canvas.getContext("2d");
if (ctx2d === null) throw new Error("no 2d context");
const ctx = ctx2d;

const card = el("card");
const cardName = el("card-name");
const cardDot = el("card-dot");
const cardStatus = el("card-status");
const cardSummary = el("card-summary");
const cardMeta = el("card-meta");
const cardRun = el<HTMLButtonElement>("card-run");
const cardWatch = el<HTMLButtonElement>("card-watch");
const cardPortrait = el<HTMLCanvasElement>("card-portrait");
const hint = el("hint");
const activity = el("activity");
const activityTitle = el("activity-title");
const activityTree = el("activity-tree");
const activityClose = el<HTMLButtonElement>("activity-close");

/** Honor the OS "reduce motion" setting — a near-still, fully-legible scene. */
const REDUCED_MOTION =
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const toastEl = el("toast");

// ── First-run onboarding wizard (dark glass) ──────────────────────────────────
// Shown on first launch; force it anytime with ?onboarding=1 (so it's testable).
// Completion is remembered per browser for now — server-side persistence is the
// onboarding-wizard spec's Slice 1.
const WELCOMED_KEY = "vesper:welcomed";

interface HelperCard {
  readonly id: string;
  readonly name: string;
  readonly line: string;
}
const WIZARD_CLIS: readonly string[] = ["claude", "codex", "opencode", "gemini"];
const WIZARD_HELPERS: readonly HelperCard[] = [
  { id: "claude", name: "Claude", line: "a careful helper for writing & planning" },
  { id: "codex", name: "Codex", line: "a hands-on coding companion" },
  { id: "opencode", name: "opencode", line: "an open coding agent" },
  { id: "gemini", name: "Gemini", line: "Google's assistant" },
  { id: "hermes", name: "Hermes", line: "a messenger that runs errands" },
  { id: "selftest", name: "Self-test", line: "keeps an eye on Vesper's health" },
];

/** Render an agent's real brand mark (resolveMark is total) into a small canvas. */
function logoCanvas(id: string, px: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = px;
  c.height = px;
  const lctx = c.getContext("2d");
  if (lctx !== null) resolveMark(id).draw(lctx, px / 2, px / 2, px * 0.36);
  return c;
}

const wizard = el("wizard");
const wDots = el("w-dots");
const wBack = el<HTMLButtonElement>("w-back");
const wNext = el<HTMLButtonElement>("w-next");
const wSteps = Array.from(wizard.querySelectorAll<HTMLElement>(".step"));
const wCount = wSteps.length;
let wStep = 0;
const picked = new Set<string>();
let wizardBuilt = false;

function buildWizardContent(): void {
  if (wizardBuilt) return;
  wizardBuilt = true;
  const clis = el("w-clis");
  for (const id of WIZARD_CLIS) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.append(logoCanvas(id, 22), document.createTextNode(id));
    chip.addEventListener("click", () => chip.classList.toggle("sel"));
    clis.append(chip);
  }
  const gallery = el("w-gallery");
  for (const helper of WIZARD_HELPERS) {
    const cardEl = document.createElement("button");
    cardEl.type = "button";
    cardEl.className = "gcard";
    const text = document.createElement("div");
    const name = document.createElement("div");
    name.className = "gname";
    name.textContent = helper.name;
    const line = document.createElement("div");
    line.className = "gline";
    line.textContent = helper.line;
    text.append(name, line);
    cardEl.append(logoCanvas(helper.id, 40), text);
    cardEl.addEventListener("click", () => {
      cardEl.classList.toggle("sel");
      if (picked.has(helper.id)) picked.delete(helper.id);
      else picked.add(helper.id);
    });
    gallery.append(cardEl);
  }
  for (let i = 0; i < wCount; i++) {
    const d = document.createElement("div");
    d.className = "dot-i";
    wDots.append(d);
  }
}

function renderWizardStep(): void {
  wSteps.forEach((s, i) => {
    s.classList.toggle("active", i === wStep);
  });
  Array.from(wDots.children).forEach((d, i) => {
    d.classList.toggle("on", i === wStep);
  });
  wBack.hidden = wStep === 0;
  wNext.textContent = wStep === 0 ? "Begin" : wStep === wCount - 1 ? "Enter your world" : "Next";
}

function finishWizard(): void {
  wizard.classList.remove("show");
  wizard.setAttribute("aria-hidden", "true");
  try {
    window.localStorage.setItem(WELCOMED_KEY, "1");
  } catch {
    // private mode — selection just won't persist.
  }
  if (picked.size > 0) {
    toast(`Added ${picked.size} helper${picked.size === 1 ? "" : "s"} — welcoming them in`);
  }
}

wBack.addEventListener("click", () => {
  if (wStep > 0) {
    wStep--;
    renderWizardStep();
  }
});
wNext.addEventListener("click", () => {
  if (wStep < wCount - 1) {
    wStep++;
    renderWizardStep();
  } else {
    finishWizard();
  }
});

function startWizard(): void {
  const forced = /[?&]onboarding=1\b/.test(window.location.search);
  let seen = false;
  try {
    seen = window.localStorage.getItem(WELCOMED_KEY) === "1";
  } catch {
    seen = false; // private mode / storage disabled → just show it.
  }
  if (!forced && seen) return;
  buildWizardContent();
  wStep = 0;
  renderWizardStep();
  wizard.classList.add("show");
  wizard.setAttribute("aria-hidden", "false");
}

let scene: SceneGraph | null = null;
let hits: HitRegion[] = [];
let hoverId: string | null = null;
let selectedId: string | null = null;
const workingIds = new Set<string>();
const pops = new Map<string, number>();
/** Latest run id seen for a pipeline (from a manual run outcome or a completed run). */
const latestRunByPipeline = new Map<string, string>();
/** The run id whose live trace the activity panel is currently following (or null). */
let activityRunId: string | null = null;
let w = 0;
let h = 0;

function resize(): void {
  const dpr = window.devicePixelRatio || 1;
  w = window.innerWidth;
  h = window.innerHeight;
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // Smooth the soft baked room; sprites use fillRect so they stay crisp regardless.
  ctx.imageSmoothingEnabled = true;
}
window.addEventListener("resize", resize);
resize();

function inhabitant(id: string | null): Inhabitant | null {
  if (id === null || scene === null) return null;
  return scene.inhabitants.find((i) => i.id === id) ?? null;
}

function timeAgo(ts: number | null): string {
  if (ts === null) return "never run";
  const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  return `${Math.round(secs / 3600)}h ago`;
}

function statusWord(inh: Inhabitant): string {
  if (inh.live) return "running now";
  if (workingIds.has(inh.id)) return "working…";
  switch (inh.mood) {
    case "ok":
      return "all good";
    case "error":
      return "needs a look";
    case "no_change":
      return "no change";
    default:
      return "resting";
  }
}

/** Draw the tapped creature's own sprite into the card's portrait well. */
function renderPortrait(avatarSeed: number): void {
  const pctx = cardPortrait.getContext("2d");
  if (pctx === null) return;
  const size = cardPortrait.width;
  pctx.clearRect(0, 0, size, size);
  const pixel = Math.max(2, Math.floor(size / (SPRITE_W + 2)));
  drawSprite(pctx, spriteFor(avatarSeed), size / 2, size / 2, pixel);
}

function renderCard(): void {
  const inh = inhabitant(selectedId);
  if (inh === null) return;
  renderPortrait(inh.avatarSeed);
  cardName.textContent = inh.label;

  // A live presence is an external agent running on this machine — read-only:
  // show that it's running, for how long, and hide the Run button (nothing to run).
  if (inh.live) {
    cardDot.className = "dot working";
    cardStatus.textContent = statusWord(inh);
    cardSummary.textContent = "This agent is running on your computer right now.";
    cardMeta.textContent = inh.liveSince !== null ? `up ${inh.liveSince}` : "running";
    cardRun.style.display = "none";
    cardWatch.hidden = true;
    return;
  }

  cardRun.style.display = "";
  const mood = workingIds.has(inh.id) ? "working" : inh.mood;
  cardDot.className = `dot ${mood}`;
  cardStatus.textContent = statusWord(inh);
  cardSummary.textContent = inh.lastSummary ?? "Hasn't done anything yet — give it a try.";
  cardMeta.textContent = `${inh.runCount} run${inh.runCount === 1 ? "" : "s"} · ${timeAgo(inh.lastRunAt)}`;
  cardRun.disabled = workingIds.has(inh.id);
  cardRun.textContent = workingIds.has(inh.id) ? "Running…" : "Run";
  // Offer the live trace only once this pipeline has a run we can follow.
  cardWatch.hidden = !latestRunByPipeline.has(inh.id);
}

function openCard(id: string): void {
  selectedId = id;
  renderCard();
  card.classList.add("open");
  hint.style.opacity = "0";
}
function closeCard(): void {
  selectedId = null;
  card.classList.remove("open");
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(message: string): void {
  toastEl.textContent = message;
  toastEl.classList.add("show");
  if (toastTimer !== undefined) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 3200);
}

async function refreshWorld(): Promise<void> {
  try {
    const res = await fetch("/api/world");
    scene = (await res.json()) as SceneGraph;
    if (selectedId !== null) renderCard();
  } catch {
    // transient; the next event/refresh recovers.
  }
}

async function runAgent(id: string): Promise<void> {
  workingIds.add(id);
  renderCard();
  try {
    const res = await fetch(`/api/pipelines/${encodeURIComponent(id)}/run`, { method: "POST" });
    const body = (await res.json()) as {
      summary?: string;
      status?: string;
      error?: string;
      runId?: string | null;
    };
    if (!res.ok) {
      toast(body.error ?? "run failed");
    } else {
      pops.set(id, performance.now());
      if (typeof body.runId === "string") latestRunByPipeline.set(id, body.runId);
      toast(body.summary ?? `${id} ran`);
    }
  } catch {
    toast("run failed");
  } finally {
    workingIds.delete(id);
    await refreshWorld();
    renderCard();
  }
}

cardRun.addEventListener("click", () => {
  if (selectedId !== null) void runAgent(selectedId);
});
cardWatch.addEventListener("click", () => {
  if (selectedId === null) return;
  const runId = latestRunByPipeline.get(selectedId);
  if (runId !== undefined) void openActivity(runId);
});

function pick(x: number, y: number): HitRegion | null {
  for (const hit of hits) {
    const dx = x - hit.cx;
    const dy = y - hit.cy;
    if (dx * dx + dy * dy <= hit.r * hit.r) return hit;
  }
  return null;
}

canvas.addEventListener("pointermove", (e) => {
  const hit = pick(e.clientX, e.clientY);
  hoverId = hit?.id ?? null;
  canvas.style.cursor = hoverId !== null ? "pointer" : "default";
});
canvas.addEventListener("pointerdown", (e) => {
  const hit = pick(e.clientX, e.clientY);
  if (hit !== null) openCard(hit.id);
  else closeCard();
});

// ── Live activity panel ───────────────────────────────────────────────────────
// The server assembles the run tree (GET /tree) and per-run trace (GET /events);
// the client is a thin renderer that backfills via replay then appends live frames.

let socket: WebSocket | null = null;

/** Send a control frame to the live socket when it is open (no-op otherwise). */
function wsSend(payload: Record<string, unknown>): void {
  if (socket !== null && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

/** Render a small brand mark for a pipeline into an inline canvas (mirrors logoCanvas). */
function markCanvas(id: string, px: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = px;
  c.height = px;
  const mctx = c.getContext("2d");
  if (mctx !== null) resolveMark(id).draw(mctx, px / 2, px / 2, px * 0.38);
  return c;
}

/** Append one trace event to a run row's scrolling log (newest at the bottom). */
function appendEventRow(log: HTMLElement, ev: RunEventInfo): void {
  const empty = log.querySelector(".empty");
  if (empty !== null) empty.remove();
  const row = document.createElement("div");
  row.className = "aevent";
  row.dataset.eventId = ev.id;
  const kind = document.createElement("span");
  kind.className = "akind";
  kind.textContent = ev.kind;
  const msg = document.createElement("span");
  msg.className = "amsg";
  msg.textContent = ev.message;
  row.append(kind, msg);
  log.append(row);
  log.scrollTop = log.scrollHeight;
}

/** Build one run row (header + step log) for the activity tree. */
function buildRunRow(node: RunTreeInfo, isChild: boolean, events: RunEventInfo[]): HTMLElement {
  const row = document.createElement("div");
  row.className = isChild ? "arow child" : "arow";
  row.dataset.runId = node.run.id;

  const top = document.createElement("div");
  top.className = "atop";
  const mark = markCanvas(node.run.pipeline, 26);
  mark.className = "amark";
  const name = document.createElement("span");
  name.className = "aname";
  name.textContent = node.run.pipeline;
  const status = document.createElement("span");
  status.className = "astatus";
  status.textContent = node.run.status;
  top.append(mark, name, status);

  const log = document.createElement("div");
  log.className = "alog";
  log.dataset.runId = node.run.id;
  const own = events.filter((e) => e.runId === node.run.id);
  if (own.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "no steps yet";
    log.append(empty);
  } else {
    for (const ev of own) appendEventRow(log, ev);
  }

  row.append(top, log);
  return row;
}

/** Find the open log element for a run id, if the activity panel is showing it. */
function logFor(runId: string): HTMLElement | null {
  return activityTree.querySelector<HTMLElement>(`.alog[data-run-id="${runId}"]`);
}

/** Render the full tree (root + children), backfilling each run's known events. */
function renderActivity(tree: RunTreeInfo, events: RunEventInfo[]): void {
  activityTree.replaceChildren();
  activityTitle.textContent = tree.run.pipeline;
  activityTree.append(buildRunRow(tree, false, events));
  for (const child of tree.children) {
    activityTree.append(buildRunRow(child, true, events));
  }
}

/** Every run id in a tree (root first, then descendants) — what we subscribe + backfill. */
function collectRunIds(node: RunTreeInfo, into: string[]): void {
  into.push(node.run.id);
  for (const child of node.children) collectRunIds(child, into);
}

/** Run ids the panel is currently subscribed to (root + every sub-agent). */
let subscribedRunIds: string[] = [];

/**
 * Open the live activity panel for a run: fetch the tree, then subscribe to AND
 * backfill EVERY node (the root and each sub-agent) so each row streams its own
 * steps live — not just the root. Live frames before a row renders are recovered by
 * the per-node `/events` backfill (every event is persisted with the same id), and
 * the de-dupe in {@link onLiveEvent} prevents double rows.
 */
async function openActivity(runId: string): Promise<void> {
  activityRunId = runId;
  activity.classList.add("open");
  activity.setAttribute("aria-hidden", "false");
  try {
    const treeRes = await fetch(`/api/runs/${encodeURIComponent(runId)}/tree`);
    if (!treeRes.ok) {
      activityTree.replaceChildren();
      activityTitle.textContent = "Activity";
      return;
    }
    const tree = (await treeRes.json()) as RunTreeInfo;
    const ids: string[] = [];
    collectRunIds(tree, ids);
    // Subscribe before backfilling so frames after the snapshot still land.
    for (const id of ids) wsSend({ type: "subscribe", runId: id });
    subscribedRunIds = ids;
    const perNode = await Promise.all(
      ids.map(async (id) => {
        const res = await fetch(`/api/runs/${encodeURIComponent(id)}/events`);
        return res.ok ? ((await res.json()) as RunEventInfo[]) : [];
      }),
    );
    if (activityRunId === runId) renderActivity(tree, perNode.flat());
  } catch {
    // transient; live frames still append as they arrive.
  }
}

function closeActivity(): void {
  for (const id of subscribedRunIds) wsSend({ type: "unsubscribe", runId: id });
  subscribedRunIds = [];
  activityRunId = null;
  activity.classList.remove("open");
  activity.setAttribute("aria-hidden", "true");
}

activityClose.addEventListener("click", closeActivity);

/** A live trace frame arrived for the run the panel is following — append it. */
function onLiveEvent(ev: RunEventInfo): void {
  if (activityRunId === null) return;
  const log = logFor(ev.runId);
  if (log === null) return; // a child row we haven't backfilled yet — refresh the tree.
  if (log.querySelector(`[data-event-id="${ev.id}"]`) !== null) return; // de-dupe replay overlap.
  appendEventRow(log, ev);
}

// Live channel: refresh + pop on every completed run, and stream live trace frames.
function connectLive(): void {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${window.location.host}/api/live`);
  socket = ws;
  ws.addEventListener("open", () => {
    // Re-open the panel after a reconnect: re-subscribes every node AND re-backfills
    // the steps missed during the disconnect window (not just a bare re-subscribe).
    if (activityRunId !== null) void openActivity(activityRunId);
    // Re-subscribe + re-backfill the active chat session over the same socket.
    chat.onSocketOpen();
  });
  ws.addEventListener("message", (ev) => {
    try {
      const msg = JSON.parse(String(ev.data)) as {
        type?: string;
        runId?: string;
        kind?: string;
        event?: RunEventInfo;
        outcome?: { taskId?: string; runId?: string | null };
        turnId?: string;
        role?: string;
        text?: string;
      };
      if (msg.type === "chat:turn") {
        // A transcript turn arrived on the chat:<sessionId> topic — the chat home
        // de-dupes against its backfilled twin, so a double-deliver is harmless.
        chat.onLiveTurn(msg);
      } else if (msg.type === "run:completed" && msg.outcome?.taskId !== undefined) {
        pops.set(msg.outcome.taskId, performance.now());
        if (typeof msg.outcome.runId === "string") {
          latestRunByPipeline.set(msg.outcome.taskId, msg.outcome.runId);
        }
        void refreshWorld();
      } else if (msg.type === "presence") {
        // An agent started or stopped on this machine — refresh the live echoes.
        void refreshWorld();
      } else if (msg.type === "run:event:lite" && typeof msg.runId === "string") {
        // A run stepped. If the panel follows it but the child row is missing, the
        // tree gained a sub-agent — re-fetch the tree to backfill the new branch.
        if (activityRunId !== null && logFor(msg.runId) === null) {
          void openActivity(activityRunId);
        }
      } else if (msg.type === "run:event" && msg.event !== undefined) {
        onLiveEvent(msg.event);
      }
    } catch {
      /* ignore */
    }
  });
  // Reconnect on drop (daemon restart, etc.).
  ws.addEventListener("close", () => {
    socket = null;
    setTimeout(connectLive, 1500);
  });
}

function frame(t: number): void {
  if (scene !== null)
    hits = activeTheme.drawScene(ctx, scene, w, h, t, {
      hoverId,
      workingIds,
      pops,
      reducedMotion: REDUCED_MOTION,
    });
  requestAnimationFrame(frame);
}

// ── Chatbot home + Helpers (templates) ────────────────────────────────────────
// The transcript is the HOME; the canvas world demotes to the activity panel. Both
// modules REUSE the live socket (wsSend) + the activity panel (openActivity) + the
// shared toast — no second transport.
const chat = new ChatHome({ wsSend, openActivity, toast });
const templates = new TemplatesScreen({ toast });

// Top-nav view switch: chat (home) / world (canvas) / templates (Helpers).
type View = "chat" | "world" | "templates";
const navButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".nav button"));
function setView(view: View): void {
  document.body.dataset.view = view;
  for (const btn of navButtons) {
    btn.setAttribute("aria-current", btn.dataset.view === view ? "true" : "false");
  }
  if (view === "world") hint.style.opacity = "1";
  else hint.style.opacity = "0";
  if (view === "templates") void templates.ensureLoaded();
  if (view === "chat") el<HTMLTextAreaElement>("chat-text").focus();
}
for (const btn of navButtons) {
  btn.addEventListener("click", () => setView((btn.dataset.view as View) ?? "chat"));
}

startWizard();
setView("chat");
void chat.restoreLatest();
void refreshWorld();
connectLive();
requestAnimationFrame(frame);

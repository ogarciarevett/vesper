/// <reference lib="dom" />
import type { Inhabitant, SceneGraph } from "../world/types.ts";
import { drawScene, type HitRegion } from "./render.ts";

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
const hint = el("hint");
const toastEl = el("toast");

let scene: SceneGraph | null = null;
let hits: HitRegion[] = [];
let hoverId: string | null = null;
let selectedId: string | null = null;
const workingIds = new Set<string>();
const pops = new Map<string, number>();
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
  ctx.imageSmoothingEnabled = false;
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

function renderCard(): void {
  const inh = inhabitant(selectedId);
  if (inh === null) return;
  cardName.textContent = inh.label;
  const mood = workingIds.has(inh.id) ? "working" : inh.mood;
  cardDot.className = `dot ${mood}`;
  cardStatus.textContent = statusWord(inh);
  cardSummary.textContent = inh.lastSummary ?? "Hasn't done anything yet — give it a try.";
  cardMeta.textContent = `${inh.runCount} run${inh.runCount === 1 ? "" : "s"} · ${timeAgo(inh.lastRunAt)}`;
  cardRun.disabled = workingIds.has(inh.id);
  cardRun.textContent = workingIds.has(inh.id) ? "Running…" : "Run";
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
    const body = (await res.json()) as { summary?: string; status?: string; error?: string };
    if (!res.ok) {
      toast(body.error ?? "run failed");
    } else {
      pops.set(id, performance.now());
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

// Live channel: refresh + pop on every completed run.
function connectLive(): void {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${window.location.host}/api/live`);
  ws.addEventListener("message", (ev) => {
    try {
      const msg = JSON.parse(String(ev.data)) as { type?: string; outcome?: { taskId?: string } };
      if (msg.type === "run:completed" && msg.outcome?.taskId !== undefined) {
        pops.set(msg.outcome.taskId, performance.now());
        void refreshWorld();
      }
    } catch {
      /* ignore */
    }
  });
  // Reconnect on drop (daemon restart, etc.).
  ws.addEventListener("close", () => setTimeout(connectLive, 1500));
}

function frame(t: number): void {
  if (scene !== null) hits = drawScene(ctx, scene, w, h, t, { hoverId, workingIds, pops });
  requestAnimationFrame(frame);
}

void refreshWorld();
connectLive();
requestAnimationFrame(frame);

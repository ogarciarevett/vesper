/// <reference lib="dom" />
import { h, type LiveBus, type SectionContext, type SectionModule } from "./section.ts";

/** Base context shared across sections (per-mount `onCleanup`/`onLive` are added by the router). */
export type RouterContext = Omit<SectionContext, "onCleanup" | "onLive">;

/**
 * Mounts exactly one {@link SectionModule} into the content host at a time. Owns
 * the hash route (`#<id>`), per-section teardown, and the active-id notification
 * the sidebar listens to. Unknown/empty routes fall back to the first section.
 */
export class SectionRouter {
  readonly #sections = new Map<string, SectionModule>();
  readonly #order: string[] = [];
  readonly #host: HTMLElement;
  readonly #ctxBase: RouterContext;
  readonly #liveBus: LiveBus;
  readonly #onChange: (id: string) => void;
  #cleanups: Array<() => void> = [];
  #activeId: string | null = null;

  constructor(
    host: HTMLElement,
    ctxBase: RouterContext,
    liveBus: LiveBus,
    onChange: (id: string) => void,
  ) {
    this.#host = host;
    this.#ctxBase = ctxBase;
    this.#liveBus = liveBus;
    this.#onChange = onChange;
    window.addEventListener("hashchange", () => {
      const id = window.location.hash.slice(1);
      if (id.length > 0 && id !== this.#activeId) void this.navigate(id);
    });
  }

  register(section: SectionModule): void {
    if (this.#sections.has(section.id)) return;
    this.#sections.set(section.id, section);
    this.#order.push(section.id);
  }

  list(): readonly SectionModule[] {
    return this.#order.map((id) => this.#sections.get(id)).filter((s): s is SectionModule => !!s);
  }

  get activeId(): string | null {
    return this.#activeId;
  }

  /** Tear down the current section, mount `id` (or the first section as fallback). */
  async navigate(id: string): Promise<void> {
    const section = this.#sections.get(id) ?? this.#sections.get(this.#order[0] ?? "");
    if (section === undefined) return;

    for (const fn of this.#cleanups.splice(0)) {
      try {
        fn();
      } catch {
        // a section's teardown must not block the next mount.
      }
    }
    this.#host.replaceChildren();
    this.#host.className = "content"; // reset any per-section class (e.g. Chat's .flush)
    this.#host.scrollTop = 0;
    this.#activeId = section.id;
    this.#onChange(section.id);

    const ctx: SectionContext = {
      ...this.#ctxBase,
      onCleanup: (fn) => {
        this.#cleanups.push(fn);
      },
      onLive: (handler) => {
        this.#liveBus.add(handler);
        this.#cleanups.push(() => this.#liveBus.remove(handler));
      },
    };
    try {
      await section.mount(this.#host, ctx);
    } catch (err) {
      this.#host.replaceChildren(
        h(
          "div",
          { class: "sec-error" },
          h("h1", { class: "sec-title" }, section.title),
          h(
            "p",
            null,
            `This section failed to load: ${err instanceof Error ? err.message : String(err)}`,
          ),
        ),
      );
    }
    if (window.location.hash.slice(1) !== section.id) {
      window.history.replaceState(null, "", `#${section.id}`);
    }
  }

  /** Boot: mount the hash route if known, else the first registered section. */
  start(): void {
    const initial = window.location.hash.slice(1);
    void this.navigate(initial.length > 0 ? initial : (this.#order[0] ?? ""));
  }
}

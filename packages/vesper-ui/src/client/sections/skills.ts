/// <reference lib="dom" />
import type { SkillDetail, SkillSummary } from "../../world/types.ts";
import { ICONS } from "../shell/icons.ts";
import {
  h,
  injectStyle,
  type SectionContext,
  type SectionModule,
  sectionHeader,
} from "../shell/section.ts";

/**
 * Skills — the shared SKILL library (read-only), reused across pipelines and Vesper.
 * Lists every skill from `GET /api/skills`; clicking one loads its SKILL.md, tasks, and
 * training status from `GET /api/skills/:name`. Training/adopting a candidate stays on the
 * cost- and confirmation-gated `vesper skill` CLI — this surface is a plain reader.
 */

const STYLE_ID = "sec-skills-style";
const STYLE = `
.sk-grid { display: grid; grid-template-columns: minmax(220px, 320px) 1fr; gap: 16px; align-items: start; }
@media (max-width: 760px) { .sk-grid { grid-template-columns: 1fr; } }
.sk-list { display: flex; flex-direction: column; gap: 6px; }
.sk-item { text-align: left; border: 1px solid var(--border); border-radius: 12px; background: var(--surface-2);
  padding: 11px 13px; cursor: pointer; color: var(--ink); font: inherit; display: flex; flex-direction: column; gap: 3px; }
.sk-item:hover { border-color: var(--border-strong); background: var(--surface-strong); }
.sk-item.active { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.sk-item .name { font-weight: 600; font-size: 14px; }
.sk-item .desc { font-size: 12.5px; color: var(--ink-soft); line-height: 1.4; max-height: 2.8em; overflow: hidden; }
.sk-item .meta { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 3px; }
.sk-detail { border: 1px solid var(--border); border-radius: 12px; background: var(--surface-2); padding: 18px; min-height: 160px; }
.sk-detail h2 { margin: 0 0 4px; font-size: 17px; }
.sk-detail .desc { color: var(--ink-soft); font-size: 13.5px; line-height: 1.5; margin: 0 0 14px; }
.sk-body { white-space: pre-wrap; word-break: break-word; font-family: var(--mono); font-size: 12.5px;
  line-height: 1.55; background: var(--surface); border: 1px solid var(--border); border-radius: 10px;
  padding: 14px; max-height: 420px; overflow: auto; }
.sk-sub { font-size: 12px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase;
  color: var(--ink-faint); margin: 16px 0 8px; }
.sk-cand { border: 1px solid var(--accent); border-radius: 10px; padding: 12px; background: var(--accent-soft); }
.sk-tasks { display: flex; flex-direction: column; gap: 6px; }
.sk-task { font-size: 12.5px; color: var(--ink-soft); }
.sk-task .id { font-family: var(--mono); color: var(--ink); }
.sk-note { font-size: 12.5px; color: var(--ink-faint); margin-top: 14px; line-height: 1.5; }
.sk-note code { font-family: var(--mono); }
`;

/** A small status badge for a skill row (training state). */
function skillBadges(s: SkillSummary): HTMLElement {
  const meta = h("div", { class: "meta" });
  meta.append(
    h("span", { class: "badge" }, s.taskCount === null ? "no harness" : `${s.taskCount} tasks`),
  );
  if (s.differs) meta.append(h("span", { class: "badge danger" }, "candidate ready"));
  else if (s.hasCandidate) meta.append(h("span", { class: "badge ok" }, "up to date"));
  return meta;
}

export const skillsSection: SectionModule = {
  id: "skills",
  title: "Skills",
  group: "vesper",
  glyph: ICONS.skills,
  async mount(host: HTMLElement, ctx: SectionContext) {
    injectStyle(STYLE_ID, STYLE);
    host.append(
      sectionHeader(
        "Skills",
        "The skill library your pipelines and Vesper share — view each skill and its training status.",
      ),
    );

    const list = h("div", { class: "sk-list" });
    const detail = h(
      "div",
      { class: "sk-detail" },
      h("p", { class: "muted" }, "Select a skill to view it."),
    );
    host.append(h("div", { class: "sk-grid" }, list, detail));

    const renderDetail = (d: SkillDetail): void => {
      const children: (HTMLElement | null)[] = [
        h("h2", {}, d.displayName),
        d.description.length > 0 ? h("p", { class: "desc" }, d.description) : null,
      ];

      if (d.hasCandidate && d.lastScore !== null) {
        const score = d.lastScore;
        children.push(
          h(
            "div",
            { class: "sk-cand" },
            h(
              "div",
              {},
              d.differs
                ? "A trained candidate is ready to adopt."
                : "Trained — candidate matches the committed skill.",
            ),
            h(
              "div",
              { class: "sk-task", style: "margin-top:6px" },
              `latest: ${score.prior.toFixed(2)} → ${score.candidate.toFixed(2)} (${score.accepted ? "accepted" : "kept prior"})`,
            ),
          ),
        );
      }

      if (d.tasks.length > 0) {
        const tasks = h("div", { class: "sk-tasks" });
        for (const t of d.tasks) {
          tasks.append(
            h(
              "div",
              { class: "sk-task" },
              h("span", { class: "id" }, t.id || "(task)"),
              ` — ${t.prompt}`,
            ),
          );
        }
        children.push(h("div", { class: "sk-sub" }, `Validation tasks (${d.tasks.length})`), tasks);
      }

      children.push(
        h("div", { class: "sk-sub" }, "SKILL.md"),
        h("div", { class: "sk-body" }, d.body),
      );
      children.push(
        h(
          "p",
          { class: "sk-note" },
          "Train or adopt from the terminal: ",
          h("code", {}, `vesper skill train ${d.name}`),
          " · ",
          h("code", {}, `vesper skill diff ${d.name}`),
          " · ",
          h("code", {}, `vesper skill accept ${d.name}`),
        ),
      );
      detail.replaceChildren(...children.filter((c): c is HTMLElement => c !== null));
    };

    const openSkill = async (name: string, item: HTMLElement): Promise<void> => {
      for (const el of list.querySelectorAll(".sk-item.active")) el.classList.remove("active");
      item.classList.add("active");
      detail.replaceChildren(h("p", { class: "muted" }, "Loading…"));
      try {
        const d = await ctx.api.getJson<SkillDetail>(`/api/skills/${encodeURIComponent(name)}`);
        renderDetail(d);
      } catch (err) {
        detail.replaceChildren(
          h("p", { class: "muted" }, err instanceof Error ? err.message : "could not load skill"),
        );
      }
    };

    try {
      const skills = await ctx.api.getJson<SkillSummary[]>("/api/skills");
      if (skills.length === 0) {
        list.append(
          h(
            "p",
            { class: "muted" },
            "No skills found. Skills live in .ai/skills — run the daemon from your Vesper repo to see them.",
          ),
        );
        return;
      }
      for (const s of skills) {
        const item = h(
          "button",
          { class: "sk-item", type: "button" },
          h("span", { class: "name" }, s.displayName),
          s.description.length > 0 ? h("span", { class: "desc" }, s.description) : null,
          skillBadges(s),
        );
        item.addEventListener("click", () => void openSkill(s.name, item));
        list.append(item);
      }
    } catch (err) {
      list.append(
        h("p", { class: "muted" }, err instanceof Error ? err.message : "could not load skills"),
      );
    }
  },
};

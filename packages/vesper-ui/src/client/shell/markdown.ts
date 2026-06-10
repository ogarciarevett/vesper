/**
 * Dependency-free markdown mini-renderer for the prompt editor's Preview tab
 * (specs/pipeline-editor.md). Deliberately small: headings, bold/italic, inline
 * code, fenced code blocks, unordered/ordered lists, blockquotes, links
 * (http/https only), paragraphs. Everything is HTML-escaped FIRST — the output
 * is safe to assign to innerHTML.
 */

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Inline spans over already-escaped text: code, bold, italic, links. */
function renderInline(escaped: string): string {
  let out = escaped;
  // Inline code first so its content is never bold/italic/linkified.
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  // Links: http/https only — anything else stays literal text.
  out = out.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
  );
  return out;
}

/** Render markdown to safe HTML (line-based; no nesting beyond one list level). */
export function renderMarkdown(source: string): string {
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  const html: string[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let code: string[] | null = null;

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    html.push(`<p>${renderInline(escapeHtml(paragraph.join(" ")))}</p>`);
    paragraph = [];
  };
  const flushList = (): void => {
    if (list === null) return;
    const tag = list.ordered ? "ol" : "ul";
    html.push(`<${tag}>${list.items.map((i) => `<li>${i}</li>`).join("")}</${tag}>`);
    list = null;
  };

  for (const line of lines) {
    // Fenced code blocks swallow everything until the closing fence.
    if (code !== null) {
      if (line.trimEnd() === "```") {
        html.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
        code = null;
      } else {
        code.push(line);
      }
      continue;
    }
    if (line.trimStart().startsWith("```")) {
      flushParagraph();
      flushList();
      code = [];
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading !== null) {
      flushParagraph();
      flushList();
      const level = (heading[1] as string).length;
      html.push(`<h${level}>${renderInline(escapeHtml(heading[2] ?? ""))}</h${level}>`);
      continue;
    }

    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+\.\s+(.*)$/);
    if (bullet !== null || numbered !== null) {
      flushParagraph();
      const ordered = numbered !== null;
      const item = renderInline(escapeHtml((bullet?.[1] ?? numbered?.[1] ?? "").trim()));
      if (list === null || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push(item);
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote !== null) {
      flushParagraph();
      flushList();
      html.push(`<blockquote>${renderInline(escapeHtml(quote[1] ?? ""))}</blockquote>`);
      continue;
    }

    if (line.trim().length === 0) {
      flushParagraph();
      flushList();
      continue;
    }
    flushList();
    paragraph.push(line.trim());
  }

  // An unterminated fence still renders as code (fail-visible, never swallowed).
  if (code !== null) html.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
  flushParagraph();
  flushList();
  return html.join("\n");
}

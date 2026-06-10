import { describe, expect, it } from "bun:test";
import { renderMarkdown } from "./markdown.ts";

describe("renderMarkdown", () => {
  it("renders headings, paragraphs, emphasis, and inline code", () => {
    const html = renderMarkdown("# Title\n\nSome **bold** and *soft* `code` text.");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>soft</em>");
    expect(html).toContain("<code>code</code>");
  });

  it("renders unordered and ordered lists", () => {
    const html = renderMarkdown("- one\n- two\n\n1. first\n2. second");
    expect(html).toContain("<ul><li>one</li><li>two</li></ul>");
    expect(html).toContain("<ol><li>first</li><li>second</li></ol>");
  });

  it("renders fenced code blocks verbatim (escaped), even unterminated", () => {
    const html = renderMarkdown("```\nconst a = 1 < 2;\n```");
    expect(html).toContain("<pre><code>const a = 1 &lt; 2;</code></pre>");
    expect(renderMarkdown("```\ndangling")).toContain("<pre><code>dangling</code></pre>");
  });

  it("escapes HTML everywhere (safe for innerHTML)", () => {
    const html = renderMarkdown('<script>alert("x")</script>');
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("links http/https only; other schemes stay literal", () => {
    const ok = renderMarkdown("[site](https://example.com)");
    expect(ok).toContain('<a href="https://example.com"');
    const bad = renderMarkdown("[x](javascript:alert(1))");
    expect(bad).not.toContain("<a ");
  });

  it("renders blockquotes", () => {
    expect(renderMarkdown("> wisdom")).toContain("<blockquote>wisdom</blockquote>");
  });
});

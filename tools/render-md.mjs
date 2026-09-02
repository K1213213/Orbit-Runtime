/**
 * render-md.mjs — zero-dependency Markdown subset renderer (docsite, W34).
 *
 * Renders exactly the Markdown features the project's own docs use: ATX
 * headings, fenced code blocks, pipe tables, blockquotes, unordered/ordered
 * lists, thematic breaks, paragraphs, and inline bold / code / links. Pure
 * functions, no I/O, no dependencies — tested in tools/render-md.test.mjs.
 */

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Inline markup: `code`, **bold**, [text](url). Order matters (code first). */
export function renderInline(text) {
  const tokens = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) tokens.push(escapeHtml(text.slice(last, m.index)));
    if (m[1] !== undefined) {
      tokens.push("<code>" + escapeHtml(m[1].slice(1, -1)) + "</code>");
    } else if (m[2] !== undefined) {
      tokens.push("<strong>" + escapeHtml(m[2].slice(2, -2)) + "</strong>");
    } else {
      const inner = m[3];
      const sep = inner.indexOf("](");
      const label = inner.slice(1, sep);
      const href = inner.slice(sep + 2, -1);
      tokens.push('<a href="' + escapeHtml(href) + '">' + escapeHtml(label) + "</a>");
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) tokens.push(escapeHtml(text.slice(last)));
  return tokens.join("");
}

function isFence(line) {
  return /^```/.test(line);
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|");
}

function parseTable(lines, i) {
  const header = splitRow(lines[i]);
  i += 1;
  if (!lines[i] || !/^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i]) || !lines[i].includes("-")) {
    return null;
  }
  i += 1; // skip the separator row
  const body = [];
  while (i < lines.length && lines[i].trim() !== "" && lines[i].trimStart().startsWith("|")) {
    body.push(splitRow(lines[i]));
    i += 1;
  }
  const head = header.map((h) => "<th>" + renderInline(h.trim()) + "</th>").join("");
  const rows = body
    .map((r) => "<tr>" + r.map((c) => "<td>" + renderInline(c.trim()) + "</td>").join("") + "</tr>")
    .join("");
  return {
    html:
      '<div class="tbl-wrap"><table><thead><tr>' +
      head +
      "</tr></thead><tbody>" +
      rows +
      "</tbody></table></div>",
    next: i
  };
}

/** Block-level render. Returns an HTML string. */
export function renderMarkdown(md) {
  const lines = String(md ?? "").replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let i = 0;
  const listStack = [];
  const closeList = (depth) => {
    while (listStack.length > depth) {
      const t = listStack.pop();
      out.push("</" + t + ">");
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    if (isFence(line)) {
      closeList(0);
      const lang = line.slice(3).trim();
      const buf = [];
      i += 1;
      while (i < lines.length && !isFence(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1; // closing fence
      out.push(
        '<pre><code class="lang-' +
          escapeHtml(lang || "text") +
          '">' +
          escapeHtml(buf.join("\n")) +
          "</code></pre>"
      );
      continue;
    }

    if (/^\s*\|.*\|\s*$/.test(line) && lines[i + 1]?.includes("-")) {
      closeList(0);
      const t = parseTable(lines, i);
      if (t) {
        out.push(t.html);
        i = t.next;
        continue;
      }
    }

    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      closeList(0);
      const level = h[1].length;
      const anchor = h[2]
        .toLowerCase()
        .replace(/[^\w\u4e00-\u9fa5]+/g, "-")
        .replace(/^-|-$/g, "");
      out.push('<h' + level + ' id="' + anchor + '">' + renderInline(h[2]) + "</h" + level + ">");
      i += 1;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      closeList(0);
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ""));
        i += 1;
      }
      out.push("<blockquote>" + renderInline(buf.join(" ")) + "</blockquote>");
      continue;
    }

    if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
      closeList(0);
      out.push("<hr>");
      i += 1;
      continue;
    }

    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      const type = ul ? "ul" : "ol";
      if (listStack.length === 0 || listStack[listStack.length - 1] !== type) {
        closeList(0);
        listStack.push(type);
        out.push("<" + type + ">");
      }
      out.push("<li>" + renderInline((ul ? ul[1] : ol[1]).trim()) + "</li>");
      i += 1;
      continue;
    }
    closeList(0);

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    const buf = [line];
    i += 1;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !isFence(lines[i]) &&
      !/^#{1,4}\s/.test(lines[i]) &&
      !/^\s*[-*]\s/.test(lines[i]) &&
      !/^\s*\|.*\|\s*$/.test(lines[i])
    ) {
      buf.push(lines[i]);
      i += 1;
    }
    out.push("<p>" + renderInline(buf.join(" ")) + "</p>");
  }
  closeList(0);
  return out.join("\n");
}

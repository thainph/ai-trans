/*
 * htmlToMarkdown — bộ chuyển HTML -> Markdown tối giản, không phụ thuộc thư viện ngoài.
 * Chạy trong context của popup (có sẵn DOMParser).
 */
(function (global) {
  "use strict";

  const BLOCK = new Set([
    "ADDRESS","ARTICLE","ASIDE","BLOCKQUOTE","DIV","DL","FIELDSET","FIGCAPTION",
    "FIGURE","FOOTER","FORM","HEADER","HR","MAIN","NAV","SECTION","TABLE","UL","OL",
    "P","PRE","H1","H2","H3","H4","H5","H6"
  ]);

  const SKIP = new Set([
    "SCRIPT","STYLE","NOSCRIPT","IFRAME","SVG","CANVAS","TEMPLATE","HEAD",
    "INPUT","BUTTON","SELECT","TEXTAREA","OBJECT","EMBED","AUDIO","VIDEO","MAP"
  ]);

  function esc(text) {
    return text
      .replace(/([\\`*_{}\[\]()#+\-.!])/g, "\\$1")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function collapse(s) {
    return s.replace(/[ \t\r\n]+/g, " ");
  }

  function repeat(ch, n) { return new Array(n + 1).join(ch); }

  // Chuyển 1 node thành markdown. opts: {keepImages, keepLinks, baseUrl}
  function walk(node, opts, listCtx) {
    let out = "";
    for (const child of node.childNodes) {
      out += render(child, opts, listCtx);
    }
    return out;
  }

  function absUrl(url, baseUrl) {
    if (!url) return "";
    try { return new URL(url, baseUrl).href; } catch (e) { return url; }
  }

  function render(node, opts, listCtx) {
    // Text node
    if (node.nodeType === 3) {
      const t = collapse(node.nodeValue);
      return t;
    }
    if (node.nodeType !== 1) return "";

    const tag = node.tagName;
    if (SKIP.has(tag)) return "";
    if (node.getAttribute && node.getAttribute("aria-hidden") === "true") return "";

    switch (tag) {
      case "H1": case "H2": case "H3":
      case "H4": case "H5": case "H6": {
        const level = Number(tag[1]);
        const text = walk(node, opts, listCtx).trim();
        if (!text) return "";
        return "\n\n" + repeat("#", level) + " " + text + "\n\n";
      }
      case "P": {
        const text = walk(node, opts, listCtx).trim();
        return text ? "\n\n" + text + "\n\n" : "";
      }
      case "BR": return "  \n";
      case "HR": return "\n\n---\n\n";
      case "STRONG": case "B": {
        const t = walk(node, opts, listCtx).trim();
        return t ? "**" + t + "**" : "";
      }
      case "EM": case "I": {
        const t = walk(node, opts, listCtx).trim();
        return t ? "*" + t + "*" : "";
      }
      case "DEL": case "S": case "STRIKE": {
        const t = walk(node, opts, listCtx).trim();
        return t ? "~~" + t + "~~" : "";
      }
      case "CODE": {
        // inline code (nếu nằm trong PRE thì đã xử lý ở PRE)
        if (node.closest && node.closest("pre")) return node.textContent;
        const t = node.textContent;
        return t ? "`" + t.replace(/`/g, "\\`") + "`" : "";
      }
      case "PRE": {
        const codeEl = node.querySelector("code");
        const raw = (codeEl ? codeEl.textContent : node.textContent).replace(/\n$/, "");
        let lang = "";
        if (codeEl && codeEl.className) {
          const m = codeEl.className.match(/language-([\w+-]+)/);
          if (m) lang = m[1];
        }
        return "\n\n```" + lang + "\n" + raw + "\n```\n\n";
      }
      case "BLOCKQUOTE": {
        const inner = walk(node, opts, listCtx).trim();
        if (!inner) return "";
        const quoted = inner.split("\n").map(l => "> " + l).join("\n");
        return "\n\n" + quoted + "\n\n";
      }
      case "A": {
        const text = walk(node, opts, listCtx).trim();
        if (!opts.keepLinks) return text;
        const href = absUrl(node.getAttribute("href"), opts.baseUrl);
        if (!href || href.startsWith("javascript:")) return text;
        return text ? "[" + text + "](" + href + ")" : "";
      }
      case "IMG": {
        if (!opts.keepImages) return "";
        const src = absUrl(node.getAttribute("src") || node.getAttribute("data-src"), opts.baseUrl);
        if (!src) return "";
        const alt = (node.getAttribute("alt") || "").trim();
        return "![" + alt + "](" + src + ")";
      }
      case "UL": case "OL": {
        return "\n" + renderList(node, opts, listCtx) + "\n";
      }
      case "LI": {
        // xử lý ở renderList; nếu lạc vào đây thì trả text
        return walk(node, opts, listCtx).trim();
      }
      case "TABLE": {
        return renderTable(node, opts, listCtx);
      }
      case "FIGCAPTION": {
        const t = walk(node, opts, listCtx).trim();
        return t ? "\n\n*" + t + "*\n\n" : "";
      }
      default: {
        let out = walk(node, opts, listCtx);
        if (BLOCK.has(tag)) out = "\n\n" + out.trim() + "\n\n";
        return out;
      }
    }
  }

  function renderList(listNode, opts, listCtx) {
    const ordered = listNode.tagName === "OL";
    const depth = (listCtx && listCtx.depth) || 0;
    const indent = repeat("  ", depth);
    let idx = ordered ? (parseInt(listNode.getAttribute("start"), 10) || 1) : 0;
    const lines = [];
    for (const li of listNode.children) {
      if (li.tagName !== "LI") continue;
      const marker = ordered ? (idx++ + ". ") : "- ";
      // tách nested list ra khỏi text
      const nested = [];
      for (const c of Array.from(li.children)) {
        if (c.tagName === "UL" || c.tagName === "OL") nested.push(c);
      }
      let text = "";
      for (const c of li.childNodes) {
        if (c.nodeType === 1 && (c.tagName === "UL" || c.tagName === "OL")) continue;
        text += render(c, opts, listCtx);
      }
      text = text.replace(/\s+/g, " ").trim();
      lines.push(indent + marker + text);
      for (const nl of nested) {
        lines.push(renderList(nl, opts, { depth: depth + 1 }));
      }
    }
    return lines.join("\n");
  }

  function renderTable(tableNode, opts, listCtx) {
    const rows = Array.from(tableNode.querySelectorAll("tr"));
    if (!rows.length) return "";
    const grid = rows.map(tr =>
      Array.from(tr.querySelectorAll("th,td")).map(cell =>
        walk(cell, opts, listCtx).replace(/\s+/g, " ").replace(/\|/g, "\\|").trim()
      )
    );
    const cols = Math.max(...grid.map(r => r.length));
    if (cols === 0) return "";
    const pad = r => { while (r.length < cols) r.push(""); return r; };
    const header = pad(grid[0]);
    let md = "\n\n| " + header.join(" | ") + " |\n";
    md += "| " + new Array(cols).fill("---").join(" | ") + " |\n";
    for (let i = 1; i < grid.length; i++) {
      md += "| " + pad(grid[i]).join(" | ") + " |\n";
    }
    return md + "\n";
  }

  function cleanup(md) {
    return md
      .replace(/ /g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/^\s+|\s+$/g, "") + "\n";
  }

  /**
   * @param {string} html  HTML string cần chuyển
   * @param {object} opts  { keepImages, keepLinks, baseUrl }
   * @returns {string} markdown
   */
  function htmlToMarkdown(html, opts) {
    opts = Object.assign({ keepImages: true, keepLinks: true, baseUrl: "" }, opts);
    const doc = new DOMParser().parseFromString(html, "text/html");
    // gỡ các phần tử nhiễu còn sót
    doc.querySelectorAll("script,style,noscript,template,svg,iframe").forEach(el => el.remove());
    const md = walk(doc.body || doc.documentElement, opts, { depth: 0 });
    return cleanup(md);
  }

  global.htmlToMarkdown = htmlToMarkdown;
})(window);

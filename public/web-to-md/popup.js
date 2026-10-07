"use strict";

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const previewEl = $("preview");

let lastMarkdown = "";
let lastFilename = "page.md";

function setStatus(msg, isError) {
  statusEl.textContent = msg;
  statusEl.classList.toggle("error", !!isError);
}

function offerOpenContent(url) {
  const btn = $("openContent");
  btn.hidden = false;
  btn.onclick = () => chrome.tabs.create({ url });
}
function hideOpenContent() {
  $("openContent").hidden = true;
}

/* =========================================================================
 * Hàm CHẠY TRONG TRANG (injected). Không dùng biến ngoài, chỉ trả về data.
 * mode: "article" | "full" | "selection"
 * ========================================================================= */
function extractInPage(mode) {
  const meta = (name) => {
    const el =
      document.querySelector(`meta[property="${name}"]`) ||
      document.querySelector(`meta[name="${name}"]`);
    return el ? (el.getAttribute("content") || "").trim() : "";
  };

  const result = {
    title: (meta("og:title") || document.title || "").trim(),
    url: location.href,
    description: meta("description") || meta("og:description") || "",
    byline: meta("author") || meta("article:author") || "",
    siteName: meta("og:site_name") || location.hostname,
    published: meta("article:published_time") || "",
    html: "",
    textLen: 0,
    isTop: window.top === window.self,
    host: location.hostname,
    mode: mode,
  };

  // Phát hiện host chứa nội dung thật của Claude artifact (iframe claudeusercontent.com)
  const slot = document.querySelector("[data-frame-uchost]");
  result.uchost = slot ? slot.getAttribute("data-frame-uchost") : "";

  const finalize = () => {
    const tmp = document.createElement("div");
    tmp.innerHTML = result.html || "";
    result.textLen = (tmp.textContent || "").replace(/\s+/g, " ").trim().length;
    return result;
  };

  // Chế độ selection
  if (mode === "selection") {
    const sel = window.getSelection();
    if (sel && sel.rangeCount && !sel.isCollapsed) {
      const div = document.createElement("div");
      for (let i = 0; i < sel.rangeCount; i++) {
        div.appendChild(sel.getRangeAt(i).cloneContents());
      }
      result.html = div.innerHTML;
    }
    return finalize();
  }

  // Chế độ full
  if (mode === "full") {
    result.html = document.body ? document.body.innerHTML : "";
    return finalize();
  }

  // Chế độ article: heuristic kiểu Readability
  const NOISE = "nav,header,footer,aside,form,button,.nav,.menu,.sidebar,.advert,.ads,.ad,.social,.share,.comment,.comments,.related,.newsletter,.subscribe,.cookie,.popup,.modal,[role=navigation],[role=banner],[role=complementary],[aria-hidden=true]";

  // 1) Ưu tiên các thẻ ngữ nghĩa
  let candidate =
    document.querySelector("article") ||
    document.querySelector("main") ||
    document.querySelector("[role=main]");

  // 2) Nếu không có, chọn container có nhiều text nhất
  if (!candidate) {
    let best = null, bestScore = 0;
    const nodes = document.querySelectorAll("div,section,article,main");
    for (const n of nodes) {
      // bỏ qua node quá nhỏ hoặc là noise
      if (n.closest(NOISE)) continue;
      const text = n.innerText || "";
      const len = text.replace(/\s+/g, " ").trim().length;
      const pCount = n.querySelectorAll("p").length;
      const linkLen = Array.from(n.querySelectorAll("a"))
        .reduce((a, el) => a + (el.innerText || "").length, 0);
      const linkDensity = len ? linkLen / len : 1;
      // điểm: ưu tiên nhiều chữ, nhiều <p>, ít mật độ link
      const score = len * (1 - linkDensity) + pCount * 50;
      if (score > bestScore) { bestScore = score; best = n; }
    }
    candidate = best || document.body;
  }

  // Clone rồi dọn noise để không phá trang thật
  const clone = candidate.cloneNode(true);
  clone.querySelectorAll(NOISE).forEach((el) => el.remove());
  clone.querySelectorAll("script,style,noscript,template,svg,iframe").forEach((el) => el.remove());

  result.html = clone.innerHTML;
  return finalize();
}

/* ========================================================================= */

function slugify(s) {
  return (s || "page")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d").replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "page";
}

function buildFrontmatter(data) {
  const esc = (v) => String(v).replace(/"/g, '\\"');
  const lines = ["---"];
  lines.push(`title: "${esc(data.title)}"`);
  lines.push(`source: "${esc(data.url)}"`);
  if (data.siteName) lines.push(`site: "${esc(data.siteName)}"`);
  if (data.byline) lines.push(`author: "${esc(data.byline)}"`);
  if (data.published) lines.push(`published: "${esc(data.published)}"`);
  lines.push(`saved: "${new Date().toISOString()}"`);
  if (data.description) lines.push(`description: "${esc(data.description)}"`);
  lines.push("---");
  return lines.join("\n") + "\n\n";
}

async function generate() {
  setStatus("Reading page…");
  hideOpenContent();
  const mode = $("mode").value;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) { setStatus("No active tab found.", true); return null; }
  if (/^(chrome|edge|about|chrome-extension|https:\/\/chrome\.google\.com\/webstore)/.test(tab.url || "")) {
    setStatus("Can't run on browser system pages.", true);
    return null;
  }

  let injection;
  try {
    injection = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: extractInPage,
      args: [mode],
    });
  } catch (e) {
    setStatus("Injection error: " + e.message, true);
    return null;
  }

  // Gom kết quả từ mọi frame (trang ngoài + các iframe, ví dụ artifact của Claude)
  const frames = (injection || [])
    .map((r) => r && r.result)
    .filter((d) => d && typeof d.textLen === "number");

  if (!frames.length) {
    setStatus("Could not extract any content.", true);
    return null;
  }

  // Metadata ưu tiên lấy từ trang ngoài cùng (top frame)
  const top = frames.find((f) => f.isTop) || frames[0];
  // Nội dung: chọn frame có nhiều chữ nhất (iframe artifact thường thắng trang vỏ)
  const best = frames.reduce((a, b) => (b.textLen > a.textLen ? b : a), frames[0]);

  const data = {
    url: top.url,
    siteName: top.siteName,
    published: top.published || best.published,
    title: (best.textLen > top.textLen && best.title) ? best.title : (top.title || best.title),
    description: top.description || best.description,
    byline: top.byline || best.byline,
    html: best.html,
    frameCount: frames.length,
    fromIframe: best !== top,
    uchost: top.uchost || "",
  };

  // Trường hợp Claude artifact: chỉ bắt được shell (nội dung nghèo) nhưng biết host nội dung thật
  const looksEmpty = !data.html || best.textLen < 40;
  if (looksEmpty && data.uchost) {
    const contentUrl = "https://" + data.uchost + location.search;
    offerOpenContent(contentUrl);
    setStatus("The artifact content is inside an iframe that can't be read. Click the button below to open the content page, then convert it.", true);
    return null;
  }

  if (looksEmpty) {
    setStatus(mode === "selection" ? "No text is selected." : "Could not extract any content (wait for the page to finish loading and try again).", true);
    return null;
  }

  const md = window.htmlToMarkdown(data.html, {
    keepImages: $("keepImages").checked,
    keepLinks: $("keepLinks").checked,
    baseUrl: data.url,
  });

  let doc = "";
  if ($("frontmatter").checked) doc += buildFrontmatter(data);
  doc += `# ${data.title}\n\n`;
  doc += md;

  lastMarkdown = doc;
  lastFilename = slugify(data.title) + ".md";

  previewEl.textContent = doc.length > 4000 ? doc.slice(0, 4000) + "\n… (preview truncated)" : doc;
  previewEl.classList.remove("muted");
  const src = data.fromIframe ? ` · from iframe (1 of ${data.frameCount} frames)` : "";
  setStatus(`Done · ${doc.length.toLocaleString("en-US")} chars · ~${Math.ceil(doc.length / 4)} tokens${src}.`);
  return doc;
}

$("download").addEventListener("click", async () => {
  const doc = await generate();
  if (!doc) return;
  const blob = new Blob([doc], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({ url, filename: lastFilename, saveAs: true });
    setStatus("Downloaded: " + lastFilename);
  } catch (e) {
    setStatus("Download error: " + e.message, true);
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
});

$("copy").addEventListener("click", async () => {
  const doc = await generate();
  if (!doc) return;
  try {
    await navigator.clipboard.writeText(doc);
    setStatus("Markdown copied to clipboard.");
  } catch (e) {
    setStatus("Copy error: " + e.message, true);
  }
});

// Đổi tuỳ chọn -> tạo lại lần bấm sau
["mode", "frontmatter", "keepImages", "keepLinks"].forEach((id) => {
  $(id).addEventListener("change", () => { lastMarkdown = ""; });
});

// Tự tạo preview khi mở popup
generate();

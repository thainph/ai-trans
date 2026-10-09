"use strict";

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const previewEl = $("preview");

let lastMarkdown = "";
/** What "Send to Devdy" posts (body without the local front matter). */
let lastCapture = null;
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

// extractInPage() lives in extract.js (loaded before this file; testable on its own).

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
  lastCapture = {
    // Selection: just the excerpt (Devdy titles it from its first line).
    markdown: mode === "selection" ? md : `# ${data.title}\n\n${md}`,
    selection: mode === "selection",
    selectionText: mode === "selection" ? (best.text || "") : undefined,
    page: {
      url: data.url,
      pageTitle: data.title || undefined,
      siteName: data.siteName || undefined,
      author: data.byline || undefined,
      description: data.description || undefined,
      publishedAt: data.published || undefined,
    },
  };

  previewEl.textContent = doc.length > 4000 ? doc.slice(0, 4000) + "\n… (preview truncated)" : doc;
  previewEl.classList.remove("muted");
  const src = data.fromIframe ? ` · from iframe (1 of ${data.frameCount} frames)` : "";
  setStatus(`Done · ${doc.length.toLocaleString("en-US")} chars · ~${Math.ceil(doc.length / 4)} tokens${src}.`);
  return doc;
}

$("download").addEventListener("click", async () => {
  const doc = await generate();
  if (!doc) return;
  const btn = $("download");

  // Images in the Markdown → a .zip (<name>.md + images/) like the Slack export.
  let note = "";
  if ($("keepImages").checked) {
    btn.disabled = true;
    setStatus("Downloading images…");
    try {
      const res = await chrome.runtime.sendMessage({
        target: "context-kit-web", type: "download-page", markdown: doc, filename: lastFilename,
      });
      if (res && res.ok && res.zipped) {
        const kept = res.images.failed ? `, ${res.images.failed} kept as links` : "";
        setStatus(`Saved ${res.filename} (${res.images.saved} image${res.images.saved === 1 ? "" : "s"}${kept})`);
        return;
      }
      if (res && res.ok && res.images.failed) note = ` (${res.images.failed} image(s) could not be downloaded; links kept)`;
      if (res && !res.ok) note = ` (zip failed: ${res.error})`;
    } catch (e) {
      note = ` (zip failed: ${e.message})`;
    } finally {
      btn.disabled = false;
    }
  }

  const blob = new Blob([doc], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({ url, filename: lastFilename, saveAs: true });
    setStatus("Saved " + lastFilename + note);
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

// Send to Devdy (POST /v1/web-pages via the background outbox)
const NEEDS_SETTINGS = ["no_token", "unauthorized", "choose_instance"];
$("devdy").addEventListener("click", async () => {
  const btn = $("devdy");
  const doc = await generate();
  if (!doc || !lastCapture) return;
  btn.disabled = true;
  setStatus("Sending to Devdy…");
  try {
    const res = await chrome.runtime.sendMessage({ target: "context-kit-web", type: "send-page", ...lastCapture });
    if (!res || !res.ok) {
      setStatus("Could not send: " + ((res && res.error) || "no response"), true);
      return;
    }
    const kind = res.result.delivery.kind;
    setStatus(res.text, kind === "rejected" || NEEDS_SETTINGS.includes(kind));
    $("openDevdy").hidden = !NEEDS_SETTINGS.includes(kind);
  } catch (e) {
    setStatus("Could not send: " + e.message, true);
  } finally {
    btn.disabled = false;
  }
});
// Switch the popup shell to the Devdy tab (token / instance settings).
$("openDevdy").addEventListener("click", () => {
  window.parent.postMessage({ type: "context-kit-open-tab", tool: "devdy" }, location.origin);
});

// Đổi tuỳ chọn -> tạo lại lần bấm sau
["mode", "frontmatter", "keepImages", "keepLinks"].forEach((id) => {
  $(id).addEventListener("change", () => { lastMarkdown = ""; });
});

// Tự tạo preview khi mở popup
generate();

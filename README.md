# Context Kit

> Gom ngữ cảnh cho AI: dịch mọi đoạn văn bản, biến trang web và Slack thread thành Markdown sạch.

Chrome extension (MV3) gộp 3 extension cũ:

| Tab | Nguồn gốc | Chức năng |
|---|---|---|
| 🌐 Translate | `ai-translator` | Dịch đoạn bôi đen / cả trang bằng OpenAI, Gemini, Ollama |
| 📄 Web → MD | `artifact-exporter` | Chuyển trang hiện tại thành Markdown (tải về / copy) |
| 💬 Slack | `slack-summarier` | Export một Slack thread ra Markdown |

## Build & cài đặt

```bash
pnpm install
pnpm build         # typecheck + vite build → dist/
pnpm test          # vitest (test của phần Slack)
pnpm dev           # build --watch
```

Mở `chrome://extensions` → bật Developer mode → **Load unpacked** → chọn `dist/`.

## Cấu trúc

```
public/                      # copy nguyên trạng vào dist/ (không bundle)
  manifest.json              # manifest gộp
  translator/                # JS thuần: content script + popup cài đặt
  web-to-md/                 # JS thuần: popup + converter
  shared/theme.css           # design system chung (Web → MD + Slack), bám theo translator/popup.css
src/
  background/index.ts        # service worker chung: import translator + slack
  background/slack-export.ts # onConnect port "slack-thread-export"
  translator/background.js   # onMessage {action: ...} + onInstalled (DNR Ollama)
  popup/                     # popup "vỏ": thanh tab + iframe cho từng tool
  slack/popup/               # popup Slack (TS)
  core/, types/              # logic Slack → Markdown
tests/                       # vitest
```

### Popup vỏ

`src/popup/shell.ts` nạp popup gốc của từng tool trong một iframe (cùng origin
extension nên `chrome.*` vẫn hoạt động). Nhờ vậy CSS/ID của 3 popup không
đụng nhau. Iframe được tạo lười (chỉ khi mở tab), tự co giãn theo nội dung.

- Tab mặc định: **Slack** nếu tab đang mở là `app.slack.com`, ngược lại là tab dùng lần trước (`chrome.storage.local.contextKitLastTab`).
- Code chạy trong iframe muốn đóng popup phải gọi `window.top.close()`.

### Slack: export kèm file đính kèm (.zip)

Khi bật **Files** + **Zip files** và thread có file, nút **Export** lưu
`slack-thread-….zip`:

```
slack-thread-dev-20231115-0513.zip
├── slack-thread-dev-20231115-0513.md   # ảnh: ![..](attachments/01-…png), file khác: 📎 [..](attachments/02-…)
└── attachments/
    ├── 01-screenshot.png
    └── 02-server-log.txt
```

- Luồng: `background/slack-export.ts` → `core/attachments.ts` (lập kế hoạch, thuần, có test)
  → `background/zip-export.ts` → **offscreen document** (`src/offscreen/`) tải file từ
  `files.slack.com` bằng cookie đăng nhập của trình duyệt, nén bằng `fflate`, trả blob URL cho
  `chrome.downloads`. (Service worker không tạo được blob URL; data URL bị giới hạn ~2 MB.)
- Chỉ tải từ `https://*.slack.com` (`isAllowedFileUrl`).
- Bỏ qua và ghi chú trong .md: file external (Google Drive…), file > 25 MB, vượt tổng 200 MB,
  tải lỗi (giữ link Slack + lý do `_(not included: …)_`).
- Không tải được file nào → lưu `.md` thường. **Copy** luôn chỉ copy text.

### Slack → Devdy (nút **Send to Devdy**)

Gửi thread vào app Devdy qua Inbox API cục bộ (hợp đồng API: `devdy/docs/slack-thread-inbox-api.md`).

- Thiết lập một lần ở mục **Devdy** cuối tab Slack: dán token lấy từ *Devdy → Settings → Inbox API*,
  chọn project (không bắt buộc).
- Có file đính kèm (bật **Files**) → gửi `.zip` (`<thread>.md` + `attachments/…`); không có → gửi `.md`.
  Devdy tự nối link `attachments/x.png` trong Markdown với file đã lưu.
- Front matter có `title`, `thread_url`, `thread_ts` → gửi lại cùng thread thì Devdy **cập nhật**, không tạo bản trùng.
- Tìm Devdy bằng `GET /health` trên cổng `47821–47830` (nhớ cổng tìm được).
- **Hàng đợi (outbox):** mọi lần gửi đều được lưu trước (`payload` trong IndexedDB, danh sách trong
  `chrome.storage.local.devdyOutbox`). Devdy tắt / thiếu token / token sai / Devdy lỗi 5xx → giữ lại,
  `chrome.alarms` gửi lại mỗi phút, và gửi ngay khi lưu token mới hoặc bấm *Retry now*.
  Lỗi không thể thử lại (400/413/415) → bỏ khỏi hàng đợi và báo lỗi.
- Giới hạn của Devdy: body ≤ 50 MB, ≤ 200 file → extension chỉ đóng gói tối đa 45 MB / 199 file đính kèm,
  phần còn lại giữ link Slack kèm ghi chú.
- Code: `core/devdy-client.ts` (gọi API), `core/devdy-outbox.ts` (hàng đợi, có test),
  `core/blob-store.ts` (IndexedDB), `background/devdy.ts` (alarm + message cho popup).

### Background

Hai kênh message độc lập: translator dùng `chrome.runtime.onMessage` với
`request.action`, Slack dùng `chrome.runtime.onConnect` (port). Thêm tính năng
mới thì tạo module riêng và import trong `src/background/index.ts`.

### Storage (`chrome.storage.sync`)

- Translator: `provider, apiKey, openaiModel, geminiApiKey, geminiModel, ollamaUrl, ollamaModel, style, targetLang, popupWidth`
- Slack: `includeReactions, includeFiles, zipFiles`
- `chrome.storage.local` — Devdy: `devdyToken, devdyPort, devdyProjectId, devdyOutbox`; popup: `contextKitLastTab`

## Lưu ý khi chuyển từ extension cũ

Extension mới có ID khác nên **cài đặt cũ không tự chuyển sang**: cần nhập lại
API key / model của Translator. Nên gỡ 3 extension cũ để tránh content script
dịch chạy 2 lần trên cùng trang.

# Context Kit

> Gom ngữ cảnh cho AI: dịch mọi đoạn văn bản, biến trang web và Slack thread thành Markdown sạch.

Chrome extension (MV3) gộp 3 extension cũ (toàn bộ mã nguồn là TypeScript):

| Tab | Nguồn gốc | Chức năng |
|---|---|---|
| 🌐 Translate | `ai-translator` | Dịch đoạn bôi đen / cả trang bằng OpenAI, Gemini, Ollama; kiểm tra ngữ pháp tiếng Anh |
| 📄 Web → MD | `artifact-exporter` | Chuyển trang hiện tại (mặc định cả trang) thành Markdown: copy / tải về (có ảnh → `.zip` gồm `.md` + `images/`) / gửi Devdy |
| 💬 Slack | `slack-summarier` | Export một Slack thread ra Markdown |
| ➤ Devdy | mới | Kết nối app Devdy: token, chọn app, hàng đợi gửi |

## Build & cài đặt

```bash
pnpm install
pnpm build         # typecheck + vite build (trang, service worker, content script IIFE) + check:dist → dist/
pnpm dev           # = dev:all: chạy mọi watcher (dev:main, dev:content, dev:slack), không minify, không xoá dist/
pnpm test          # vitest
pnpm typecheck     # tsc --noEmit
pnpm lint          # Biome (lint + kiểm tra format), có warning là fail
pnpm lint:ci       # như lint nhưng dùng `biome ci` (cho CI, không sửa file)
pnpm format        # Biome tự format
pnpm check:dist    # mọi file mà dist/manifest.json, HTML và code tham chiếu đều tồn tại (build đã chạy sẵn)
```

Mở `chrome://extensions` → bật Developer mode → **Load unpacked** → chọn `dist/`.
CI (`.github/workflows/ci.yml`) chạy `lint:ci`, `test`, `build` (typecheck nằm trong `build`). Lint phải sạch: 0 warning, 0 info.

## Cấu trúc

```
public/                      # chỉ manifest.json + icons (copy nguyên trạng vào dist/)
src/
  background/index.ts        # service worker: chỉ import module background của từng feature
  offscreen/                 # offscreen document: tải file/ảnh (image-fetch, url-safety), nén zip dạng stream (zip-stream)
  popup/                     # popup "vỏ": thanh tab + iframe cho từng tool
  content/all-frames.ts      # entry content script mọi trang/mọi frame → dist/content.js; nối nút ➤ của Translator với Web → MD
  shared/                    # code dùng chung, không phụ thuộc feature nào:
                             #   async (mapLimit), bytes (formatBytes, ByteBudget), errors, filename, keepalive,
                             #   messaging (Result, onTargetMessage, Command, sendToTab), offscreen/ (protocol + zip-job),
                             #   popup-tabs, runtime, sender, toast, yaml, styles/ (tokens.css, theme.css)
  features/
    translator/              # background (gọi LLM, CORS Ollama), content (thanh nút + popup dịch, dịch cả trang), core, popup, shared
    web-to-md/               # core (extract, converter, front matter), content (gửi đoạn chọn), background, popup
    slack/                   # core (Slack → Markdown), content (menu Send to Devdy), background (export), popup
    devdy/                   # core (client, outbox, blob-store), background, popup, api.ts (API cho feature khác)
tests/                       # vitest
scripts/check-dist.mjs       # kiểm tra dist/ sau build
```

Mỗi feature chia `core/` (logic thuần, có test), `background/`, `content/`, `popup/` và `messages.ts`.
Content script build thành IIFE riêng (`vite.content.config.ts`): `content.js` (mọi trang) và `slack-content.js` (app.slack.com).
Bản build được minify; các hàm chạy trong trang (`pageSlackApi`, `extractInPage`) phải tự chứa (không import/closure) —
`tests/minified-injection.test.ts` kiểm tra bản minify vẫn chạy được.

Design token CSS nằm ở `src/shared/styles/tokens.css`, dùng chung cho `theme.css` (Web → MD, Slack, Devdy), popup Translator và popup vỏ.

### Quy tắc phụ thuộc

`tests/dependencies.test.ts` kiểm tra tự động:

- `src/shared/` không import gì ngoài `src/shared/`.
- `src/features/<tên>/` chỉ import `src/shared/`, chính thư mục của nó, và `src/features/devdy/api.ts`
  (API dịch vụ của Devdy: `outbox`, `openSettings`, `SendOutcome`, `DevdyDelivery`, `DEVDY_MAX_ATTACHMENTS`).
  Các feature không import lẫn nhau.
- Entry point (`src/background/`, `src/offscreen/`, `src/popup/`, `src/content/`) được import shared và feature;
  việc nối các feature với nhau làm ở đây (vd `content/all-frames.ts` gọi `setSelectionSender(sendSelection)`).

### Popup vỏ

`src/popup/shell.ts` nạp popup gốc của từng tool trong một iframe (cùng origin
extension nên `chrome.*` vẫn hoạt động). Nhờ vậy CSS/ID của các popup không
đụng nhau. Iframe được tạo lười (chỉ khi mở tab), tự co giãn theo nội dung.

- Tab mặc định: tab được yêu cầu mở một lần (`contextKitOpenTab`, vd từ "Open settings"), ngược lại **Slack** nếu tab đang mở là
  `app.slack.com`, ngược lại là tab dùng lần trước (`contextKitLastTab`). Khoá và kiểu nằm ở `src/shared/popup-tabs.ts`.
- Code chạy trong iframe muốn đóng popup phải gọi `window.top.close()`; muốn chuyển tab thì gọi `requestOpenTab(tool)`.

### Message và kiểm tra người gửi

Mỗi kênh message có một `target` riêng và đăng ký bằng `onTargetMessage()` (`src/shared/messaging.ts`),
phản hồi theo dạng `Result<T>` (`{ ok: true, ... }` hoặc `{ ok: false, error }`): `context-kit-translator`
(gọi LLM), `context-kit-translator-page` (popup → tab: dịch/hoàn tác cả trang), `context-kit-devdy`,
`context-kit-quick-send`, `context-kit-web`, `context-kit-offscreen`. Toast từ background xuống tab dùng `sendToTab()`.
Export Slack dùng port `slack-thread-export` (`chrome.runtime.onConnect`). Thêm tính năng mới: tạo `src/features/<tên>/`
và import module background của nó trong `src/background/index.ts`.

Người gửi được phân loại một chỗ duy nhất (`src/shared/sender.ts`):

- **extension sender**: `sender.id` là extension này (mọi context, kể cả content script);
- **extension page**: extension sender có URL `chrome-extension://<id>/…` (popup, offscreen, service worker) — content script
  luôn báo URL của trang web nên không bao giờ thuộc loại này;
- **content script từ origin X**: extension sender chạy trong frame có đúng origin X.

Danh sách được phép nằm trong từng feature: Translator nhận mọi request từ extension sender, riêng `fetch-ollama-models` chỉ từ
extension page (có giới hạn kích thước; `cancel` chỉ huỷ được request của chính frame đó); Devdy và offscreen chỉ nhận từ
extension page; Web → MD cho content script gửi `send-selection` / `open-settings`, còn `send-page` / `download-page` chỉ từ
extension page; port export Slack chỉ từ extension page; gửi nhanh Slack chỉ từ content script trên `https://app.slack.com`.

### Translator

- Cài đặt: kiểu + mặc định duy nhất ở `src/features/translator/shared/settings.ts`.
- Thanh nút nổi và popup kết quả dùng Shadow DOM **closed**; mọi handler bỏ qua event giả (`isTrusted`) để script của trang
  không điều khiển được UI. Đóng popup hoặc gửi request mới sẽ huỷ request đang chạy. Mọi lời gọi LLM có timeout
  (120 s, Ollama 300 s, danh sách model 10 s).
- **Dịch cả trang** chỉ chạy ở frame trên cùng: phần đang hiển thị trước, phần còn lại khi cuộn tới; văn bản giống nhau chỉ dịch
  một lần; tối đa 20 request/phút cho nội dung tải thêm. Mỗi batch gửi một mảng JSON và nhận `{"translations": [...]}` đúng số
  phần tử (`core/batch-protocol.ts`). Phần tử thiếu/lỗi (`null`: sai số lượng, JSON bị cắt…) giữ nguyên văn bản gốc, không
  cache, và được thử lại sau 2 s, tối đa 2 lần mỗi đoạn.
- **CORS Ollama:** rule `declarativeNetRequest` chỉ xoá header `Origin` trên request do chính extension gửi
  (`initiatorDomains`) tới origin Ollama đã cấu hình (và URL vừa thử trong popup); request của trang web tới localhost không bị
  đụng tới. Rule được cập nhật lại khi `ollamaUrl` đổi.

### Web → MD: Export kèm ảnh (.zip)

**Export** khi chip **Images** bật và nội dung có ảnh → lưu `<tên>.zip` gồm `<tên>.md` + `images/01-…png`
(link ảnh trong md trỏ sang file trong zip). Ảnh tải lỗi giữ URL gốc; không có ảnh / không tải được ảnh nào /
không tạo được zip → lưu `.md`. Dùng chung đường tải ảnh với Send to Devdy (offscreen `fetch-image`,
`features/web-to-md/background/web-capture.ts`).
Front matter (chip **Frontmatter**) dùng chung định dạng với Devdy: `title, url, site_name, author, published_at, captured_at, description, selection`.

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

- Luồng: `features/slack/background/export.ts` → `features/slack/core/attachments.ts` (lập kế hoạch, thuần, có test)
  → `shared/offscreen/zip-job.ts` → **offscreen document** (`src/offscreen/`) tải file từ
  `files.slack.com` bằng cookie đăng nhập của trình duyệt, nén bằng `fflate`, trả blob URL cho
  `chrome.downloads`. (Service worker không tạo được blob URL; data URL bị giới hạn ~2 MB.)
- Chỉ tải từ `https://*.slack.com` (`isAllowedFileUrl`).
- Bỏ qua và ghi chú trong .md: file external (Google Drive…), file > 25 MB, vượt tổng 200 MB,
  tải lỗi (giữ link Slack + lý do `_(not included: …)_`).
- Không tải được file nào → lưu `.md` thường. **Copy** luôn chỉ copy text.

### Offscreen document

- Zip được ghi **dạng stream** (`ZipWriter`, fflate `Zip`): mỗi file tải xong được đưa thẳng vào zip (định dạng đã nén như
  png/jpg/pdf/zip được lưu nguyên, còn lại nén deflate), dữ liệu gom thành Blob mỗi 8 MB — không giữ mọi file trong bộ nhớ cùng lúc.
- Các lượt tải song song giữ chỗ dung lượng trong một `ByteBudget` chung trước khi tải, nên không bao giờ vượt tổng giới hạn.
- Đóng document 10 s sau job cuối (có alarm `offscreen-close` dự phòng); service worker mới khởi động sẽ đóng document còn sót.
  Job không hoạt động 15 phút bị giải phóng.
- **Chính sách tải ảnh web:** chỉ `http(s)` và `data:image`; từ chối host nội bộ (loopback, mạng riêng, link-local, CGNAT,
  multicast, `localhost`, `*.local`). Cookie chỉ gửi cho ảnh cùng origin với trang, kèm `redirect: 'error'` (request có cookie
  không bao giờ đi theo redirect; lỗi thì thử lại một lần không cookie). Request không cookie dùng `redirect: 'follow'` rồi kiểm
  tra lại URL cuối. Hạn chế: Chrome giấu `Location` khi `redirect: 'manual'` nên không kiểm tra trước được từng bước redirect
  (bước trung gian không cookie có thể chạm host nội bộ, phản hồi bị bỏ); host chỉ được kiểm tra theo tên/IP viết sẵn, không
  phân giải DNS (không phát hiện DNS rebinding). Phản hồi không phải ảnh bị từ chối.

### Gửi sang Devdy

Gửi Slack thread và trang web vào app Devdy qua Inbox API cục bộ (hợp đồng API: `devdy/docs/inbox-api.md`).

- Thiết lập một lần ở **tab Devdy**: dán token lấy từ *Devdy → Settings → Inbox API*.
  Không gửi project — Devdy tự gán project sau.
- **Nhiều app Devdy cùng chạy** (vd bản production + bản dev): tab Devdy hiện ô **Devdy app** để chọn cổng.
  Chưa chọn thì không gửi vào app nào (export nằm trong hàng đợi, toast báo "pick one").

| Gửi gì | Cách gửi | Endpoint |
|---|---|---|
| Slack thread | Chuột phải tin nhắn → **Send to Devdy** (trong menu của Slack), hoặc tab Slack | `/v1/slack-threads` |
| Đoạn văn bản đang bôi đen | Nút **➤** trên thanh nút nổi (cạnh **T**), mọi trang web | `/v1/web-pages` (`selection: true`, tiêu đề = dòng đầu đoạn chọn) |
| Cả trang | Tab Web → MD → **Send to Devdy** | `/v1/web-pages` (`selection: false`; gửi lại cùng URL → Devdy cập nhật) |

- Trang web: ảnh trong nội dung được tải về zip (`page.md` + `images/01-…png`) và link trong md đổi sang đường dẫn
  tương đối; ảnh tải lỗi giữ URL gốc. Không có ảnh → gửi `.md`. Ảnh `blob:` trong đoạn chọn được nhúng thành data URL.
- Nút ➤ không hiện khi bôi đen trong ô nhập liệu. Không thêm mục nào vào menu chuột phải của trình duyệt.
- Tìm Devdy bằng `GET /health` trên cổng `47821–47830`. Mọi lời gọi Devdy chạy trong service worker / offscreen, không bao giờ
  trong content script.

#### Slack thread
- Có file đính kèm (bật **Files**) → gửi `.zip` (`<thread>.md` + `attachments/…`); không có → gửi `.md`.
  Devdy tự nối link `attachments/x.png` trong Markdown với file đã lưu.
- Front matter có `title`, `thread_url`, `thread_ts` → gửi lại cùng thread thì Devdy **cập nhật**, không tạo bản trùng.
- Giới hạn của Devdy: body ≤ 50 MB, ≤ 200 file → extension chỉ đóng gói tối đa 45 MB / 199 file đính kèm,
  phần còn lại giữ link Slack kèm ghi chú.
- **Gửi nhanh ngay trong Slack:** chuột phải vào một tin nhắn (hoặc bấm ⋮ *More actions*) → menu của Slack có thêm
  **Send to Devdy** (ngay sau *Copy link*). Gửi cả thread chứa tin nhắn đó, luôn kèm reactions + file đính kèm;
  tiến trình/kết quả hiện bằng toast góc dưới phải. Content script `src/features/slack/content/` (build riêng thành
  `dist/slack-content.js` dạng IIFE bằng `vite.content.config.ts`).
- Nếu Slack đổi giao diện khiến không chèn được vào menu thì vẫn gửi được từ tab Slack (dán link thread).
- Gỡ lỗi việc nhận diện tin nhắn/menu: trên app.slack.com chạy `localStorage.setItem('context-kit-debug', '1')`
  rồi reload, xem log `[context-kit]` trong Console.

#### Hàng đợi (outbox)
Mọi lần gửi đều được lưu trước: nội dung trong IndexedDB, danh sách trong `chrome.storage.local.devdyOutbox`,
trạng thái thử lại trong `devdyOutboxState` (`features/devdy/core/outbox.ts`, có test).

- Devdy tắt / phải chọn app / thiếu token / token sai / Devdy lỗi 5xx → giữ trong hàng đợi. Alarm `devdy-outbox-retry`
  gửi lại theo backoff 1 → 2 → 5 → 15 → 60 phút (lặp 60 phút; về lại 1 phút khi gửi được). Gửi ngay khi lưu token
  mới, chọn app hoặc bấm *Retry now*.
- Token sai / thiếu token → **tạm dừng** tự gửi lại cho tới khi lưu token (token sai không tính là một lần thử).
- Lỗi 5xx của một export chỉ tính một lần thử cho export đó; hàng đợi vẫn gửi tiếp các export sau (một payload lỗi không
  chặn cả hàng đợi). Devdy tắt / chưa chọn app / lỗi token thì dừng lượt gửi đó.
- Payload bị Devdy từ chối (400/413/415…) → chuyển thành **bản ghi lỗi** (không gửi lại), tab Devdy cho tải về hoặc xoá;
  giữ tối đa 20 bản ghi.
- Giới hạn: export chưa gửi được sau 7 ngày hoặc 20 lần thử bị bỏ (có thông báo); tổng dung lượng ≤ 300 MB (xoá bản ghi lỗi
  cũ nhất trước, không bao giờ xoá export đang chờ).
- Mỗi request có `Idempotency-Key: <id export>` và danh sách được lưu ngay sau mỗi lần gửi thành công, nên service worker
  bị dừng giữa chừng cũng không gửi trùng.
- Dữ liệu IndexedDB không còn thuộc export nào bị xoá khi khởi động/cài đặt và trước mỗi lượt gửi (zip đang ghi được giữ lại).

### Giới hạn kích thước

| Nội dung | Giới hạn |
|---|---|
| Translator | văn bản 100 000 ký tự, batch 200 phần tử; mỗi đoạn khi dịch cả trang ≤ 4 000 ký tự |
| File đính kèm Slack (export) | 25 MB/file, tổng 200 MB |
| Slack → Devdy | tổng 45 MB, 199 file |
| Ảnh web | 10 MB/ảnh, tổng 45 MB, 199 ảnh |
| Ảnh `blob:` trong đoạn chọn | 5 MB/ảnh, tổng 10 MB |
| Markdown gửi lên background | 30 MB |
| Body gửi Devdy | 50 MB |
| Outbox | 300 MB, 7 ngày, 20 lần thử, 20 bản ghi lỗi |

### Storage

- `chrome.storage.sync` — Translator: `provider, apiKey, openaiModel, geminiApiKey, geminiModel, ollamaUrl, ollamaModel, style, targetLang, popupWidth, popupHeight`
  (kiểu + mặc định duy nhất: `src/features/translator/shared/settings.ts`); Slack: `includeReactions, includeFiles, zipFiles`
- `chrome.storage.local` — Devdy: `devdyToken, devdyPort, devdyPortPinned, devdyOutbox`, `devdyOutboxState` (tạm dừng / backoff / thông báo);
  popup: `contextKitLastTab`, `contextKitOpenTab` (mở tab một lần)
- IndexedDB `context-kit` (store `devdy-outbox`) — nội dung các lần gửi đang chờ / bị từ chối

## Lưu ý khi chuyển từ extension cũ

Extension mới có ID khác nên **cài đặt cũ không tự chuyển sang**: cần nhập lại
API key / model của Translator. Nên gỡ 3 extension cũ để tránh content script
dịch chạy 2 lần trên cùng trang.

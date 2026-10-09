# Kiến trúc Context Kit

Tài liệu cho người phát triển: cách các phần của extension nói chuyện với nhau và các quyết định kỹ thuật
quan trọng. Hướng dẫn sử dụng nằm ở [README](../README.md); quy ước cho agent viết code nằm ở [CLAUDE.md](../CLAUDE.md).

## Tổng quan

```
popup vỏ (src/popup) ── iframe ──► trang của từng tab (features/*/popup)
        │                                   │ chrome.runtime.sendMessage / port
        ▼                                   ▼
service worker (src/background) ──► offscreen document (src/offscreen): tải file/ảnh, nén zip
        ▲                                   │
        │ message                           └──► IndexedDB (outbox Devdy) / blob: URL cho chrome.downloads
content script (content.js mọi frame, slack-content.js trên app.slack.com)
```

- **Service worker** (`src/background/index.ts`) chỉ import module background của từng feature. Đây là nơi duy nhất gọi
  LLM và Devdy (cùng với offscreen document) — không bao giờ gọi từ content script (CORS và
  `Private Network Access` — cơ chế Chrome chặn trang web gọi vào mạng nội bộ).
- **Offscreen document** tồn tại vì service worker MV3 không tạo được `blob:` URL, còn `data:` URL bị giới hạn khoảng 2 MB.
- **Content script** được build thành IIFE (`vite.content.config.ts`) vì content script không dùng được `import`:
  `dist/content.js` (Translator + gửi đoạn chọn, chạy ở mọi frame) và `dist/slack-content.js` (app.slack.com).

## Popup vỏ

`src/popup/shell.ts` nạp trang của từng tool trong một iframe cùng origin với extension, nên `chrome.*` vẫn dùng được
mà CSS/ID của các tool không đụng nhau. Iframe được tạo lười (khi mở tab lần đầu) và tự co giãn theo nội dung.

- Tab mở đầu tiên: tab được yêu cầu mở một lần (`contextKitOpenTab`, vd từ nút "Open Devdy settings"), nếu không thì
  **Slack** khi tab trình duyệt đang ở `https://app.slack.com/`, nếu không thì tab dùng lần trước (`contextKitLastTab`).
- Code trong iframe muốn đóng popup gọi `window.top.close()`; muốn chuyển tab gọi `requestOpenTab(tool)`
  (`src/shared/popup-tabs.ts`).

## Message và kiểm tra người gửi

### Kênh message

Mỗi kênh request/response là một listener `chrome.runtime.onMessage` lọc theo chuỗi `target`
(`onTargetMessage()` trong `src/shared/messaging.ts`). Phản hồi luôn có dạng `Result<T>`:
`{ ok: true, ... }` hoặc `{ ok: false, error }`. Bên gửi dựng request bằng kiểu `Command<R>` (request chưa có `target`).

| Target | Hướng | Dùng cho |
|---|---|---|
| `context-kit-translator` | content script / popup → SW | dịch, kiểm tra ngữ pháp, batch dịch trang, huỷ, lấy danh sách model Ollama |
| `context-kit-translator-page` | popup Translate → tab (frame 0) | dịch / hoàn tác cả trang |
| `context-kit-devdy` | tab Devdy → SW | trạng thái, lưu token, chọn app, gửi lại, xoá/tải bản ghi lỗi |
| `context-kit-quick-send` | content script Slack → SW | "Send to Devdy" trong menu Slack |
| `context-kit-web` | content script / tab Web → MD → SW | gửi đoạn chọn, gửi/tải cả trang, mở cài đặt Devdy |
| `context-kit-offscreen` | SW → offscreen | `fetch-file`, `fetch-image`, `build-zip`, `store-zip`, `release` |
| `context-kit-toast`, `context-kit-web-toast` | SW → tab (`sendToTab()`) | toast tiến trình/kết quả trong trang |

Export Slack từ tab Slack dùng **port** `slack-thread-export` (`chrome.runtime.onConnect`) để đẩy tiến trình liên tục.

### Phân loại người gửi

Định nghĩa duy nhất ở `src/shared/sender.ts`:

- **extension sender**: `sender.id` là ID của extension này (mọi context, kể cả content script).
- **extension page**: extension sender có `sender.url` bắt đầu bằng `chrome-extension://<id>/` (popup, offscreen,
  service worker). Content script luôn báo URL của trang web nên không bao giờ thuộc loại này.
- **content script từ origin X**: extension sender chạy trong frame có đúng origin X.

### Danh sách được phép (nằm trong từng feature)

| Kênh | Được phép |
|---|---|
| Translator (`translator/background/sender.ts`) | mọi extension sender; riêng `fetch-ollama-models` chỉ từ extension page. Kích thước được kiểm tra (văn bản ≤ 100 000 ký tự, batch ≤ 200 phần tử, tổng ≤ 100 000 ký tự). `cancel` chỉ huỷ được request của chính frame gửi (`requestKey`). |
| Devdy, offscreen | chỉ extension page |
| Web → MD | `send-selection` / `open-settings` từ content script; `send-page` / `download-page` chỉ từ extension page. Markdown nhận vào ≤ 30 × 1024 × 1024 ký tự (`background/limits.ts`). |
| Slack | port export chỉ từ extension page; gửi nhanh chỉ từ content script trên `https://app.slack.com` |

## Translator

- **Cài đặt**: kiểu + giá trị mặc định duy nhất ở `features/translator/shared/settings.ts` (`loadSettings()` /
  `saveSettings()`). Khi cài/cập nhật, chỉ ghi `SEEDED_SETTINGS` (không bao giờ ghi API key).
- **Gọi LLM** chỉ ở `background/index.ts`: OpenAI chat completions, Gemini `generateContent`, Ollama `/api/chat`.
  Timeout: 120 s (Ollama 300 s, danh sách model 10 s). Đoạn chọn dài được chia khúc ≤ 4 000 ký tự.
- **UI trong trang** (thanh nút nổi và popup kết quả) dùng Shadow DOM **closed** — script của trang không đọc/sửa được.
  Mọi handler bỏ qua event giả (`e.isTrusted`), nên trang web không "bấm hộ" được. Đóng popup hoặc mở request mới sẽ
  gửi `cancel` để huỷ lời gọi LLM đang chạy.
- **Dịch cả trang** (`content/page-translation.ts`):
  - Chỉ chạy ở frame trên cùng (popup gửi với `frameId: 0`), iframe không tự dịch.
  - Phần đang hiển thị dịch trước; phần còn lại dịch khi cuộn tới (`IntersectionObserver`, lề 50 %).
  - Văn bản giống nhau chỉ dịch một lần (`TranslationCache`); đoạn > 4 000 ký tự bị bỏ qua.
  - Batch tối đa 60 đoạn / ~3 000 ký tự. Nội dung tải thêm được gom (debounce 400 ms), không chạy chồng và tối đa
    20 request/phút (`RateLimiter`).
  - Văn bản gốc giữ trong `WeakOriginals` để hoàn tác.
- **Giao thức batch** (`core/batch-protocol.ts`): gửi một mảng JSON các chuỗi, yêu cầu trả về
  `{"translations": [...]}` đúng số phần tử (bật JSON mode theo từng provider). `parseBatchResponse()` trả một bản dịch
  hoặc `null` cho mỗi phần tử: sai số lượng → tất cả `null`; JSON bị cắt → lấy các phần tử đầu còn nguyên; vẫn đọc được
  định dạng cũ `[N] text`. Phần tử `null` giữ văn bản gốc, không cache, và được thử lại sau 2 s, tối đa 2 lần mỗi
  đoạn (`RetryBudget`).
- **CORS của Ollama** (`background/ollama-cors.ts`): Ollama từ chối request có header `Origin` lạ. Extension cài các
  rule `declarativeNetRequest` động (id 1–3) chỉ xoá `Origin` trên request **do chính extension gửi**
  (`initiatorDomains: [id extension]`) tới origin Ollama đã cấu hình — `ollamaUrl` đã lưu và URL vừa thử trong popup.
  Request của trang web tới localhost không bị đụng tới. Rule được đồng bộ lại khi `ollamaUrl` đổi.

## Web → MD

- Luồng: `core/extract.ts` (chạy trong mọi frame) → `core/converter.ts` (`htmlToMarkdown`) → front matter
  `webFrontMatter()` (`core/web-capture.ts`) sinh bằng `src/shared/yaml.ts`.
- Trích xuất 2 lượt: lượt 1 mọi frame chỉ báo metadata + độ dài văn bản (đếm trên bản sao trơ, không chạy script);
  lượt 2 chỉ lấy HTML của frame nhiều chữ nhất (vd iframe artifact thắng trang vỏ). Metadata ưu tiên frame trên cùng.
- Artifact của Claude nằm trong iframe không đọc được: popup đưa nút mở trang nội dung (URL lấy từ tab).
- Gửi đoạn chọn (`content/send-selection.ts`): ảnh `blob:` được nhúng thành data URL (≤ 5 MB/ảnh, ≤ 10 MB/lần).

## Slack

- `pageSlackApi` (`core/slack-client.ts`) chạy trong trang app.slack.com (world `MAIN`) bằng session của người dùng;
  token Slack không bao giờ rời khỏi trang. Khi bị rate limit, service worker chờ theo `Retry-After` (≤ 10 phút) và
  ping giữ cho worker sống.
- File đính kèm: `core/attachments.ts` lập kế hoạch tải (chỉ `https://*.slack.com`, 25 MB/file, tổng 200 MB; file
  external như Google Drive bị bỏ qua). `md-builder` viết file đã tải thành link tương đối, file bị bỏ kèm ghi chú
  `_(not included: …)_`. Gửi Devdy giới hạn 45 MB / 199 file.
- Gửi nhanh trong Slack (`content/`): `message-dom.ts` tìm menu tin nhắn theo thứ tự `data-qa` → class `c-*` → ARIA;
  không khớp thì không làm gì. Mục "Send to Devdy" được chèn ngay sau "Copy link" (hoặc cuối menu).

## Offscreen document

- **Zip dạng stream** (`zip-stream.ts`, `Zip` của fflate): mỗi file tải xong được đưa thẳng vào `ZipWriter` của job
  (định dạng đã nén như png/jpg/pdf/zip được lưu nguyên, còn lại nén deflate); dữ liệu gom thành phần Blob mỗi 8 MB;
  file Markdown được ghi **cuối cùng**. Kết quả là `blob:` URL cho `chrome.downloads` (`build-zip`) hoặc Blob lưu vào
  IndexedDB cho outbox (`store-zip`). Không tạo được zip → export lùi về Markdown thường.
- Các lượt tải song song giữ chỗ dung lượng trong một `ByteBudget` chung trước khi tải, nên tổng không bao giờ vượt
  giới hạn. Mỗi lượt tải có timeout 120 s. Job không hoạt động 15 phút bị giải phóng.
- **Vòng đời**: document đóng 10 s sau job cuối (hẹn giờ sau một ping keepalive), có alarm `offscreen-close` dự phòng;
  service worker mới khởi động mà không có job sẽ đóng ngay document còn sót.

### Chính sách tải ảnh web (`image-fetch.ts`, `url-safety.ts`)

- Chỉ nhận URL `http(s)` hoặc `data:image/…`; URL chứa thông tin đăng nhập bị từ chối.
- Từ chối host nội bộ: loopback, mạng riêng, link-local, CGNAT (100.64/10), multicast (IPv4/IPv6 viết sẵn),
  `localhost`, `*.localhost`, `*.local`.
- **Cookie** chỉ gửi cho ảnh cùng origin với trang, kèm `redirect: 'error'` — request có cookie không bao giờ đi theo
  redirect; lỗi thì thử lại một lần không cookie.
- Request không cookie dùng `redirect: 'follow'`, rồi kiểm tra lại URL cuối; URL cuối là host nội bộ → bỏ phản hồi.
- Phản hồi bị từ chối khi `Content-Type` không phải `image/*` **và** URL không có đuôi ảnh nhận biết được.
- Hạn chế đã biết:
  - Chrome giấu `Location` với `redirect: 'manual'` (trả về `opaqueredirect`), nên không kiểm tra trước được từng bước
    redirect: bước trung gian (không cookie) có thể chạm host nội bộ, nhưng phản hồi bị bỏ.
  - Host chỉ được kiểm tra theo tên/IP viết sẵn, không phân giải DNS (extension không có API DNS), nên không phát hiện
    tên public trỏ về IP nội bộ hay `DNS rebinding` (đổi bản ghi DNS sau khi đã kiểm tra).

## Devdy

- Gửi qua Inbox API cục bộ: `POST http://127.0.0.1:{47821..47830}/v1/{slack-threads|web-pages}`, header
  `Authorization: Bearer <token>`, body ≤ 50 MB. Tìm app bằng `GET /health` (timeout 800 ms) trên dải cổng đó.
  Hợp đồng API: `devdy/docs/inbox-api.md` (repo Devdy).
- Chọn app (`resolveDevdy()`): đã ghim cổng (`devdyPortPinned`) thì chỉ dùng cổng đó; nếu không, dùng app duy nhất đang
  chạy; nhiều app mà chưa ghim → giữ trong hàng đợi (`choose_instance`), không bao giờ đoán.
- Feature khác chỉ dùng `features/devdy/api.ts`.

### Outbox (`features/devdy/core/outbox.ts`)

Mọi export được lưu trước rồi mới gửi: payload trong IndexedDB `context-kit` / store `devdy-outbox`
(`core/blob-store.ts`, offscreen `store-zip` cũng ghi vào đây), danh sách trong `chrome.storage.local.devdyOutbox`,
trạng thái thử lại trong `devdyOutboxState` (`paused`, `backoff`, `notice`).

- Mọi thao tác đọc-sửa-ghi danh sách và mọi lượt gửi chạy tuần tự (một chuỗi Promise).
- Gửi theo thứ tự cũ → mới. Trước khi gửi: tìm app; không có app (`unreachable`) / nhiều app (`choose_instance`) /
  thiếu token (`no_token`) → dừng lượt, không tính lần thử.
- Kết quả từng export:
  - `created` / `updated` → xoá khỏi danh sách và **lưu ngay** (worker bị dừng giữa chừng không gửi trùng), rồi xoá blob.
  - `server_error` (5xx) → tính một lần thử cho export đó, **gửi tiếp** export sau.
  - `unauthorized` (401) → không tính lần thử, dừng lượt.
  - `rejected` (400/403/413/415…) → thành **bản ghi lỗi** (không gửi lại).
- Sau lượt gửi: `unauthorized` / `no_token` → **tạm dừng** tự gửi lại cho tới khi lưu token mới. Còn hàng chờ thì hẹn
  alarm một lần `devdy-outbox-retry` theo bậc 1 → 2 → 5 → 15 → 60 phút (bậc cuối lặp lại; về bậc đầu khi gửi được).
  Lưu token, chọn app hoặc bấm *Retry now* thì gửi ngay.
- Header `Idempotency-Key: <id export>` cho phép Devdy loại bản gửi trùng sau sự cố.
- Giới hạn:
  - export trong hàng chờ quá 7 ngày hoặc 20 lần thử bị bỏ (kèm thông báo ở tab Devdy); bản ghi lỗi cũng hết hạn sau
    7 ngày;
  - giữ tối đa 20 bản ghi lỗi (mới nhất);
  - tổng dung lượng ≤ 300 MB: cần chỗ thì xoá bản ghi lỗi cũ nhất trước, không bao giờ xoá export đang chờ; vẫn không đủ
    chỗ → export mới **không được nhận** (báo hàng đợi đầy).
- Dọn rác: blob không thuộc export nào bị xoá khi khởi động/cài đặt và trước mỗi lượt gửi; `outbox.hold(id)` bảo vệ zip
  đang được ghi trước khi `enqueue`.

## Build

- `vite.config.ts` build các trang (`src/popup/index.html`, `src/features/*/popup/popup.html`,
  `src/offscreen/offscreen.html`) và service worker. `vite.content.config.ts --mode all-frames|slack` build từng content
  script thành IIFE. Bản build được minify; script watch truyền `--minify false` và không xoá `dist/`.
- Hàm chạy trong trang qua `chrome.scripting.executeScript({ func })` (`pageSlackApi`, `extractInPage`) bị serialize
  thành chuỗi: phải **tự chứa** (không import/closure; import kiểu thì được). `tests/minified-injection.test.ts` kiểm tra
  bản minify vẫn chạy độc lập.
- `scripts/check-dist.mjs` kiểm tra mọi file mà `dist/manifest.json`, HTML và code tham chiếu đều tồn tại.

# Context Kit

> Gom ngữ cảnh cho AI: dịch mọi đoạn văn bản, biến trang web và Slack thread thành Markdown sạch.

Chrome extension (Manifest V3) gộp 3 extension cũ (`ai-translator`, `artifact-exporter`, `slack-summarier`) vào một
popup với 4 tab:

| Tab | Làm gì |
|---|---|
| 🌐 **Translate** | Dịch đoạn bôi đen hoặc cả trang bằng OpenAI, Gemini hay Ollama (chạy máy mình); sửa ngữ pháp tiếng Anh khi đang gõ. |
| 📄 **Web → MD** | Chuyển trang đang mở thành Markdown: copy, tải về (`.md`, hoặc `.zip` kèm ảnh) hay gửi sang Devdy. |
| 💬 **Slack** | Export một Slack thread ra Markdown (kèm reactions, file đính kèm), hoặc gửi thẳng sang Devdy. |
| ➤ **Devdy** | Kết nối app Devdy trên máy: token, chọn app, xem hàng đợi gửi. |

Xem [CHANGELOG.md](CHANGELOG.md) cho các thay đổi gần đây.

## Cài đặt

Cần Node.js 22 và `pnpm` 9.

```bash
pnpm install
pnpm build        # tạo thư mục dist/
```

1. Mở `chrome://extensions` → bật **Developer mode**.
2. Bấm **Load unpacked** → chọn thư mục `dist/`.
3. Ghim biểu tượng Context Kit lên thanh công cụ cho tiện.

Sau mỗi lần build lại, bấm nút reload của extension trong `chrome://extensions` (và reload các tab đang mở).

### Lưu ý khi chuyển từ extension cũ

- Extension mới có ID khác nên **cài đặt cũ không tự chuyển sang**: cần nhập lại API key / model của Translator.
- Nên **gỡ 3 extension cũ**, nếu không thanh nút dịch sẽ hiện 2 lần trên cùng trang.

## Hướng dẫn sử dụng

Bấm biểu tượng Context Kit để mở popup. Popup mở lại tab dùng lần trước; riêng khi đang ở `app.slack.com` thì mở
thẳng tab **Slack**.

### 🌐 Translate

**Thiết lập (một lần, trong tab Translate):** chọn **Provider** (OpenAI / Gemini / Ollama), dán API key, chọn model,
**Translation Style** (Casual / Polite / Business) và **Target Language** (mặc định tiếng Việt) → **Save Settings**.

**Dịch đoạn bôi đen:** bôi đen văn bản trên bất kỳ trang nào, một thanh nút nhỏ hiện ngay dưới đoạn chọn:

| Nút | Khi nào hiện | Tác dụng |
|---|---|---|
| **T** | luôn có | Dịch đoạn chọn sang ngôn ngữ đích. Trong popup kết quả có thể đổi ngôn ngữ đích, đổi văn phong, **Copy**. |
| **G** | bôi đen trong ô nhập liệu (input, textarea, ô soạn thảo) | Kiểm tra ngữ pháp tiếng Anh; **Replace** ghi đè bản đã sửa vào chỗ đang gõ. |
| **R** | bôi đen trong ô nhập liệu, sau khi đã dịch ít nhất một lần | Dịch ngược sang ngôn ngữ của đoạn vừa dịch trước đó. Vd: đọc tin tiếng Nhật → dịch sang tiếng Việt, rồi gõ trả lời tiếng Việt → **R** dịch câu trả lời sang tiếng Nhật. |
| **➤** | bôi đen văn bản của trang (không phải ô nhập liệu) | Gửi đoạn chọn sang Devdy (xem tab Devdy). |

Popup kết quả kéo được 4 cạnh để đổi kích thước, kích thước được nhớ cho lần sau. Đóng popup sẽ huỷ yêu cầu dịch đang
chạy.

**Dịch cả trang:** tab Translate → **Translate This Page**. Phần đang thấy trên màn hình được dịch trước, phần còn lại
dịch dần khi cuộn tới; bấm **Revert Translation** để trả về văn bản gốc. Chỉ dịch nội dung của trang chính, không dịch
nội dung trong iframe.

**Dùng Ollama (chạy model trên máy):**

1. Cài [Ollama](https://ollama.com), tải một model, vd `ollama pull qwen2.5:7b`, và để Ollama chạy.
2. Tab Translate → Provider **Ollama** → **Ollama URL** (mặc định `http://localhost:11434`) → chọn model (danh sách model được
   lấy tự động từ Ollama; bấm nút làm mới cạnh ô **Model** để tải lại) → **Save Settings**.
3. Không cần đặt biến `OLLAMA_ORIGINS`: extension tự xử lý header `Origin` cho request của chính nó tới URL Ollama này.

### 📄 Web → MD

1. Mở trang cần lấy, mở tab **Web → MD**.
2. Chọn **Content**: *Entire page* (mặc định), *Main content* (đoán phần nội dung chính), hoặc *Selected text only*.
3. Bật/tắt các chip **Options**:
   - **Frontmatter** — thêm khối YAML đầu file: `title, url, site_name, author, published_at, captured_at, description,
     selection`;
   - **Images** — giữ ảnh; khi export sẽ tải ảnh về;
   - **Links** — giữ link.
4. Bấm:
   - **Export** — lưu file. Có ảnh (chip Images bật) → `<tên>.zip` gồm `images/01-….png` + `<tên>.md` (link ảnh trong md
     trỏ vào file trong zip). Ảnh tải lỗi giữ nguyên URL gốc; không có ảnh hoặc không tạo được zip → lưu `.md`.
   - **Copy** — copy Markdown vào clipboard.
   - **Send to Devdy** — gửi cả trang sang Devdy, ảnh được đóng gói kèm.

Phần **Preview** hiện trước tối đa 4 000 ký tự đầu, kèm số ký tự và ước lượng số token.
Với artifact của Claude (nội dung nằm trong iframe không đọc được), tab sẽ hiện nút mở trang nội dung — mở trang đó rồi
chuyển đổi lại.

### 💬 Slack

Cần một tab `app.slack.com` đã đăng nhập (extension dùng chính phiên đăng nhập đó).

**Từ tab Slack trong popup:**

1. Dán link thread (*Copy link* của một tin nhắn, dạng `https://<team>.slack.com/archives/C…/p…`).
2. Chọn **Options**: **Reactions**, **Files** (tải file đính kèm), **Zip files** (đóng gói file vào zip khi export).
3. Bấm **Export** (lưu file), **Copy** (chỉ copy text) hoặc **Send to Devdy**.

Khi bật **Files** + **Zip files** và thread có file, **Export** lưu một zip:

```
slack-thread-dev-20231115-0513.zip
├── attachments/
│   ├── 01-screenshot.png
│   └── 02-server-log.txt
└── slack-thread-dev-20231115-0513.md   # ảnh: ![..](attachments/01-…png), file khác: 📎 [..](attachments/02-…)
```

File không được đưa vào zip (file external như Google Drive, file > 25 MB, vượt tổng 200 MB, tải lỗi) vẫn giữ link
Slack kèm ghi chú `_(not included: …)_`. Không tải được file nào → lưu `.md` thường.

**Gửi nhanh ngay trong Slack:** chuột phải vào một tin nhắn (hoặc bấm ⋮ *More actions*) → menu của Slack có thêm
**Send to Devdy** (ngay sau *Copy link*). Lệnh này gửi cả thread chứa tin nhắn đó, luôn kèm reactions và file đính kèm;
tiến trình và kết quả hiện bằng thông báo ở góc dưới bên phải. Nếu Slack đổi giao diện khiến mục này không hiện, vẫn
gửi được từ tab Slack trong popup.

> **Gỡ lỗi:** nếu mục *Send to Devdy* không hiện, trên `app.slack.com` mở DevTools Console, chạy
> `localStorage.setItem('context-kit-debug', '1')`, reload trang rồi xem các dòng log `[context-kit]`.

### ➤ Devdy

Devdy là app chạy trên máy, lưu Slack thread và trang web làm ngữ cảnh. Context Kit gửi vào Devdy qua API cục bộ
trên máy (`127.0.0.1`), không qua internet.

**Thiết lập:** mở Devdy → *Settings → Inbox API* → copy token → dán vào ô **Inbox API token** ở tab Devdy → **Save**.
Không cần chọn project — Devdy tự gán sau.

**Ba cách gửi:**

| Gửi gì | Cách gửi |
|---|---|
| Slack thread | chuột phải tin nhắn → **Send to Devdy**, hoặc tab Slack → **Send to Devdy** |
| Đoạn văn bản đang bôi đen | nút **➤** trên thanh nút nổi (tiêu đề = dòng đầu của đoạn chọn) |
| Cả trang | tab Web → MD → **Send to Devdy** |

Gửi lại cùng một Slack thread hoặc cùng một URL trang → Devdy **cập nhật** bản cũ, không tạo bản trùng.

**Nhiều app Devdy cùng chạy** (vd bản chính thức + bản dev): tab Devdy hiện ô **Devdy app** để chọn app nhận. Khi chưa
chọn, extension không đoán: các lần gửi nằm chờ cho tới khi bạn chọn.

**Hàng đợi:** mọi lần gửi đều được lưu lại trước, nên không mất dữ liệu khi Devdy chưa chạy.

- Devdy đang tắt, chưa chọn app, Devdy tạm lỗi → bản gửi nằm trong hàng đợi và tự gửi lại sau 1, 2, 5, 15 rồi mỗi
  60 phút. Bấm **Retry now** để gửi ngay; lưu token hoặc chọn app cũng gửi ngay.
- Thiếu token hoặc token sai → tạm ngừng tự gửi lại cho tới khi bạn lưu token đúng.
- Devdy từ chối nội dung (vd quá lớn) → chuyển sang mục **Not accepted by Devdy**: tải về để giữ lại, hoặc **Dismiss**.
- Bản gửi không thành công sau 7 ngày hoặc 20 lần thử sẽ bị bỏ, tab Devdy có thông báo. Hàng đợi chứa tối đa 300 MB;
  đầy thì lần gửi mới bị từ chối — hãy mở Devdy để hàng đợi được gửi đi.

## Quyền riêng tư & bảo mật

- **Văn bản cần dịch** chỉ được gửi tới provider bạn chọn (OpenAI, Gemini, hoặc Ollama trên máy). API key lưu trong
  `chrome.storage.sync` của trình duyệt.
- **Devdy** chỉ được gọi ở `127.0.0.1` (máy của bạn); token Devdy lưu trong `chrome.storage.local`.
- **Slack:** export chạy trong tab Slack bằng phiên đăng nhập của bạn; token Slack không rời khỏi trang. File đính kèm
  chỉ tải từ `*.slack.com`.
- **Ảnh của trang web:** cookie chỉ được gửi khi ảnh cùng origin (cùng giao thức + tên miền + cổng) với trang; địa chỉ
  nội bộ (localhost, mạng LAN, `*.local`…) bị chặn để trang web không lợi dụng extension dò mạng nội bộ.
- Thanh nút dịch và popup kết quả được cô lập khỏi script của trang và chỉ phản hồi thao tác thật của người dùng.
- Extension không thêm mục nào vào menu chuột phải của trình duyệt.

## Giới hạn

| Nội dung | Giới hạn |
|---|---|
| Dịch đoạn chọn | 100 000 ký tự mỗi lần |
| Dịch cả trang | bỏ qua đoạn > 4 000 ký tự; nội dung tải thêm tối đa 20 request/phút |
| File đính kèm Slack (export) | 25 MB/file, tổng 200 MB |
| Slack → Devdy | tổng 45 MB, 199 file |
| Ảnh trang web (export / gửi Devdy) | 10 MB/ảnh, tổng 45 MB, 199 ảnh |
| Ảnh `blob:` trong đoạn chọn | 5 MB/ảnh, tổng 10 MB |
| Markdown của một trang | 30 × 1024 × 1024 ký tự (≈ 30 MB) |
| Một lần gửi Devdy | 50 MB |
| Hàng đợi Devdy | 300 MB, 7 ngày, 20 lần thử, 20 bản ghi lỗi |

## Phát triển

### Scripts

```bash
pnpm build        # typecheck + vite build (trang, service worker, 2 content script IIFE) + check:dist → dist/
pnpm dev          # = dev:all: chạy song song dev:main, dev:content, dev:slack (watch, không minify, không xoá dist/)
pnpm test         # vitest
pnpm test:watch   # vitest ở chế độ watch
pnpm typecheck    # tsc --noEmit
pnpm lint         # Biome: lint + kiểm tra format, có warning là fail
pnpm lint:ci      # như lint nhưng dùng `biome ci` (không sửa file)
pnpm format       # Biome tự sửa format
pnpm check:dist   # mọi file mà dist/ tham chiếu đều tồn tại (build đã chạy sẵn)
```

### Cấu trúc

```
public/                  manifest.json + icons (copy nguyên trạng vào dist/)
src/
  background/index.ts    service worker: chỉ import module background của từng feature
  offscreen/             offscreen document: tải file/ảnh, nén zip dạng stream
  popup/                 popup vỏ: thanh tab + một iframe cho mỗi tool
  content/all-frames.ts  content script mọi trang/mọi frame → dist/content.js
  shared/                code dùng chung, không phụ thuộc feature nào (messaging, sender, yaml, toast, styles…)
  features/
    translator/          dịch đoạn chọn / cả trang, kiểm tra ngữ pháp
    web-to-md/           trang web → Markdown, gửi đoạn chọn
    slack/               Slack thread → Markdown, gửi nhanh trong Slack
    devdy/               client Devdy, hàng đợi (outbox); api.ts là API cho feature khác
tests/                   vitest
scripts/check-dist.mjs   kiểm tra dist/ sau build
docs/architecture.md     kiến trúc chi tiết
```

Mỗi feature chia `core/` (logic thuần, không dùng `chrome.*`, có unit test), `background/`, `content/`, `popup/` và
`messages.ts`.

### Quy tắc phụ thuộc

Được kiểm tra tự động bởi `tests/dependencies.test.ts`:

- `src/shared/` không import gì ngoài `src/shared/`.
- `src/features/<tên>/` chỉ import `src/shared/`, chính thư mục của nó và `src/features/devdy/api.ts`. Các feature không
  import lẫn nhau.
- Việc nối các feature với nhau làm ở entry point (`src/background/`, `src/offscreen/`, `src/popup/`, `src/content/`),
  vd `content/all-frames.ts` nối nút ➤ của Translator với Web → MD.

### Thêm một tính năng

1. Tạo `src/features/<tên>/` với `core/`, `background/`, `popup/`… và `messages.ts` (một `target` riêng, xử lý bằng
   `onTargetMessage()`).
2. Import module background trong `src/background/index.ts`; nếu có tab, thêm trang popup vào `src/popup/shell.ts`,
   `src/shared/popup-tabs.ts` và `rollupOptions.input` của `vite.config.ts`.
3. Kiểm tra người gửi bằng các hàm trong `src/shared/sender.ts` (xem [docs/architecture.md](docs/architecture.md)).
4. Viết test cho `core/`, chạy `pnpm lint && pnpm test && pnpm build`.

### Test, lint, CI

- Test dùng vitest + happy-dom, import thẳng module TypeScript. `tests/minified-injection.test.ts` kiểm tra các hàm
  được inject vào trang vẫn chạy được sau khi minify.
- CI (`.github/workflows/ci.yml`, khi push lên `main` và với pull request): `pnpm lint:ci` → `pnpm test` → `pnpm build`
  (typecheck nằm trong `build`). Lint phải sạch: 0 warning, 0 info.

### Tài liệu thêm

- [docs/architecture.md](docs/architecture.md) — message và kiểm tra người gửi, Translator, offscreen document, chính sách
  tải ảnh, hàng đợi Devdy.
- [CLAUDE.md](CLAUDE.md) — quy ước ngắn gọn cho AI agent làm việc trên repo (kèm bảng storage key và vị trí các hằng số
  giới hạn).

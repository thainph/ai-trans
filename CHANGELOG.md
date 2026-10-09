# Thay đổi

## Chưa phát hành — tái cấu trúc TypeScript

Toàn bộ extension được viết lại bằng TypeScript và tổ chức lại theo từng feature. Phần lớn thay đổi nằm bên trong;
dưới đây là những gì người dùng và người phát triển cần biết.

### Thay đổi người dùng thấy được

- **Web → MD: đổi tên khóa front matter** cho thống nhất với dữ liệu gửi sang Devdy:
  `source` → `url`, `site` → `site_name`, `published` → `published_at`, `saved` → `captured_at`
  (thêm khóa `selection`). Nếu bạn có script đọc các file `.md` cũ, hãy cập nhật tên khóa.
- **Web → MD: tên file giữ nguyên chữ có dấu / chữ không phải Latin** (giống export Slack): trang "Hướng dẫn cài đặt"
  → `Hướng-dẫn-cài-đặt.md` thay vì `huong-dan-cai-dat.md`; tiêu đề tiếng Nhật/Trung không còn bị mất ký tự.
- **Dịch cả trang không còn dịch nội dung trong iframe** — chỉ dịch trang chính, tránh mỗi iframe tự gọi LLM riêng.
- **Trong file `.zip`, file `.md` là mục cuối cùng** (sau `images/` hoặc `attachments/`), vì zip giờ được ghi dạng
  stream (từng phần, không giữ toàn bộ trong bộ nhớ).
- Không tạo được zip (khi export hoặc gửi Devdy) → tự lùi về file `.md` thường (giữ link gốc) thay vì báo lỗi cả lần gửi.

### Bảo mật

- **Ollama:** trước đây extension xoá header `Origin` trên **mọi** request tới `localhost` / `127.0.0.1`, kể cả request
  của trang web. Giờ chỉ xoá trên request do chính extension gửi tới đúng URL Ollama đã cấu hình.
- **Kiểm tra người gửi message:** mỗi kênh chỉ nhận lệnh từ đúng nơi được phép (vd chỉ trang của extension mới gọi được
  Devdy và offscreen; gửi nhanh Slack chỉ từ app.slack.com), có giới hạn kích thước dữ liệu.
- **Chỉ nhận thao tác thật:** thanh nút dịch và popup kết quả dùng Shadow DOM đóng và bỏ qua event do script tạo ra,
  nên trang web không đọc được nội dung hay "bấm hộ".
- **Tải ảnh an toàn hơn:** chặn địa chỉ nội bộ (localhost, mạng LAN, `*.local`…), cookie chỉ gửi cho ảnh cùng origin
  với trang và không bao giờ theo redirect, có giới hạn dung lượng và thời gian.

### Hiệu năng và độ tin cậy

- **Dịch cả trang rẻ hơn:** dịch phần đang hiển thị trước, phần còn lại khi cuộn tới; văn bản trùng chỉ dịch một lần;
  tối đa 20 request/phút cho nội dung tải thêm; phản hồi thiếu/lỗi của model được thử lại tối đa 2 lần mỗi đoạn.
- Mọi lời gọi LLM có timeout; đóng popup kết quả sẽ huỷ yêu cầu đang chạy.
- **Hàng đợi Devdy bền hơn:** dữ liệu lưu trong IndexedDB, tự gửi lại với thời gian chờ tăng dần, không gửi trùng khi
  trình duyệt dừng service worker giữa chừng, một bản gửi lỗi không chặn cả hàng đợi, có giới hạn tuổi / số lần thử /
  dung lượng.
- Export zip lớn không còn giữ mọi file trong bộ nhớ cùng lúc; offscreen document được đóng khi rảnh.

### Cho người phát triển

- Mã nguồn 100 % TypeScript; mỗi feature nằm trong `src/features/<tên>/`, quy tắc phụ thuộc được test tự động.
- Biome cho lint + format (0 warning), CI chạy `lint:ci`, `test`, `build`; `check:dist` kiểm tra bản build.
- Chi tiết: [docs/architecture.md](docs/architecture.md).

# HƯỚNG DẪN DEPLOY CHATBOT MESSENGER (v1.1)

> Bản này đã thêm: xác thực webhook, lưu chat persistent, tách sản phẩm ra file riêng, human handoff, ghi đơn lead.

---

## BƯỚC 1 — LẤY GEMINI API KEY (miễn phí)

1. Vào: https://aistudio.google.com/apikey
2. Đăng nhập Google → bấm **"Create API Key"**
3. Copy key lại (dạng: `AIza...`)

---

## BƯỚC 2 — TẠO FACEBOOK APP & LẤY TOKEN

1. Vào: https://developers.facebook.com → đăng nhập
2. **My Apps → Create App → Business** → điền tên app → Create
3. Trong app dashboard: tìm **Messenger → Set Up**
4. Kéo xuống **Access Tokens** → chọn Facebook Page của shop → **Generate Token**
   - Copy lại `FB_PAGE_TOKEN` (rất dài, bắt đầu `EAAB...`)
5. Vào **Settings → Basic** → ô **App Secret** → bấm **Show**
   - Copy lại `FB_APP_SECRET` (chuỗi 32 ký tự)

---

## BƯỚC 3 — CẤU HÌNH BIẾN MÔI TRƯỜNG

Cần 4 biến (5 nếu tính `PORT`):

| Biến | Lấy ở đâu | Bắt buộc |
|---|---|---|
| `GEMINI_API_KEY` | Bước 1 | Có |
| `FB_PAGE_TOKEN` | Bước 2 (Access Token) | Có |
| `FB_VERIFY_TOKEN` | Tự đặt một chuỗi ngẫu nhiên (vd: `shopbot_x7k2p9q`) | Có |
| `FB_APP_SECRET` | Bước 2 (App Secret) | Khuyến nghị |
| `PORT` | Railway/Render tự set, local dùng `3000` | Không |

### Chạy local

```bash
cp .env.example .env
# mở .env và điền các giá trị bên trên
npm install
npm run dev
```

### Deploy lên Railway

1. Vào https://railway.app → đăng ký bằng GitHub
2. **New Project → Deploy from GitHub repo** (push code lên GitHub trước)
3. Sau khi deploy: **Settings** → copy domain (`xxx.railway.app`)
4. **Variables** → thêm 4 biến `GEMINI_API_KEY`, `FB_PAGE_TOKEN`, `FB_VERIFY_TOKEN`, `FB_APP_SECRET`
5. Nếu muốn lưu lead không mất sau restart/deploy: tạo Railway Volume, mount vào `/data`, rồi thêm biến `DATA_DIR=/data`

---

## BƯỚC 4 — KẾT NỐI WEBHOOK VỚI FACEBOOK

1. developers.facebook.com → App → **Messenger → Settings**
2. **Webhooks → Add Callback URL**
   - **Callback URL**: `https://xxx.railway.app/webhook`
   - **Verify Token**: chuỗi bạn đặt ở `FB_VERIFY_TOKEN`
3. Bấm **Verify and Save** → thấy ✅ là OK
4. **Add Subscriptions** → tick: `messages`, `messaging_postbacks`, `message_echoes` → Save
   - `message_echoes` quan trọng để bot biết khi nào nhân viên thật trả lời tay

---

## BƯỚC 5 — TEST

1. Vào Facebook Page → **Send Message**
2. Gõ: *"Cho mình xem sản phẩm"*
3. Bot trả lời tự động.
4. Thử gõ *"cho gặp nhân viên"* → bot ngừng tư vấn 30 phút (handoff).

---

## TÍNH NĂNG MỚI

### Tách sản phẩm ra `products.csv`
Muốn thêm/sửa sản phẩm: chỉ cần sửa file `products.csv`, không cần đụng code.
Bot đọc file CSV một lần lúc khởi động, nên sau khi sửa sản phẩm trên production cần restart service.

```csv
code,price,description,size,weight,gift,preorder,imageFile
MÃ14,500k,Mô tả ngắn,10x20cm,700g,5 gói gel,false,ma14.jpg
```

### Cấu hình shop/rule-based
Các chính sách và nhóm sản phẩm gợi ý nằm trong `shop-config.js`.
Khi đổi sang dự án/shop khác, thường chỉ cần sửa:

- `products.csv`: danh sách sản phẩm, giá, mô tả, ảnh
- `shop-config.js`: miễn ship, COD/đặt cọc, thời gian hàng đặt, tuổi tối thiểu, nhóm sản phẩm gợi ý

Phần rule xử lý intent nằm trong `rules.js`, còn `index.js` chỉ giữ webhook Messenger, gửi ảnh và gọi Gemini.

### Human handoff
- Khách gõ `nhân viên`, `admin`, `người thật`, `tư vấn viên` → bot tạm dừng 30 phút.
- Khi nhân viên trả lời tay từ trang Facebook → bot tự dừng 30 phút (qua `message_echoes`).

### Lưu và tải lead khách hàng
Khi khách gửi tin nhắn có số điện thoại VN, bot tự động ghi vào `customers.csv` kèm thông tin đơn và 10 tin gần nhất. Nếu có set `DATA_DIR=/data` trên Railway thì file sẽ nằm ở `/data/customers.csv` trong Volume.

Để tải CSV bằng trình duyệt, thêm biến Railway:

```bash
ADMIN_EXPORT_TOKEN=chuoi_bi_mat_that_dai
```

Sau khi redeploy, mở URL sau để tải:

```txt
https://ten-app.up.railway.app/admin/customers.csv?token=chuoi_bi_mat_that_dai
```

Nếu muốn kiểm tra bằng Railway CLI:

```bash
npm i -g @railway/cli
railway login
railway link
railway run sh -lc "ls -la /data && sed -n '1,20p' /data/customers.csv"
```

Nếu Volume của Railway mount ở path khác `/data`, hãy set `DATA_DIR` đúng bằng mount path đó.

### Bảo mật webhook
Nếu set `FB_APP_SECRET`, bot sẽ kiểm tra `X-Hub-Signature-256`. Request không có chữ ký hợp lệ sẽ bị từ chối.

### Health check
- `GET /` → trạng thái text
- `GET /healthz` → JSON gồm số sản phẩm và uptime

---

## CHI PHÍ THỰC TẾ

| Dịch vụ | Chi phí |
|---|---|
| Railway hosting | Miễn phí (500 giờ/tháng) |
| Gemini API | ~40-80k VNĐ/tháng (100 khách/ngày) |
| Facebook Messenger API | Miễn phí |
| **TỔNG** | **~40-80k VNĐ/tháng** |

---

## XỬ LÝ LỖI THƯỜNG GẶP

❌ **Webhook verify thất bại**
→ Kiểm tra `FB_VERIFY_TOKEN` có khớp giữa Railway và Facebook không.

❌ **Bot không trả lời**
→ Check log Railway. Thường do thiếu `FB_PAGE_TOKEN` hoặc `GEMINI_API_KEY`.
→ Bot cũng có thể đang ở chế độ handoff, đợi 30 phút hoặc xoá `data/chat-state.json`.

❌ **Webhook trả 403**
→ Sai `FB_APP_SECRET` hoặc thiếu chữ ký. Kiểm tra lại App Secret.

❌ **Lỗi Gemini API**
→ Quota hết hoặc key sai.

---

## CẢNH BÁO

- Sản phẩm thuộc danh mục 18+. Tuân thủ chính sách Meta về quảng cáo và tin nhắn.
- Không đăng nội dung phản cảm trên Page; bot đã được nhắc giữ ngôn ngữ kín đáo nhưng bạn vẫn nên review log định kỳ.
- File `data/` chứa thông tin khách (sđt, lịch sử chat). KHÔNG commit lên Git công khai.

---

## NÂNG CẤP TIẾP THEO (tuỳ chọn)

- Gửi ảnh sản phẩm khi khách hỏi mã cụ thể (cần host ảnh URL công khai).
- Sync `customers.csv` lên Google Sheet bằng Apps Script.
- Chuyển chat history từ file sang Redis/Postgres khi khách đông.
- Quick Replies trên Messenger (gợi ý nút bấm).

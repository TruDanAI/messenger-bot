# HƯỚNG DẪN DEPLOY CHATBOT MESSENGER

> Bản hiện tại đã có: xác thực webhook, lưu chat/state persistent, rule engine theo config, NLP normalize tiếng Việt, gửi ảnh tự động, human handoff, ghi lead, admin export/debug và test suite.

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

Cần tối thiểu `FB_PAGE_TOKEN`, `FB_VERIFY_TOKEN`. Nếu bật Gemini thì cần thêm `GEMINI_API_KEY`.

| Biến | Lấy ở đâu | Bắt buộc |
|---|---|---|
| `GEMINI_API_KEY` | Bước 1 | Có nếu `USE_GEMINI` không phải `false` |
| `GEMINI_MODEL` | Tên model Gemini, mặc định `gemini-2.5-flash` | Không |
| `FB_PAGE_TOKEN` | Bước 2 (Access Token) | Có |
| `FB_VERIFY_TOKEN` | Tự đặt một chuỗi ngẫu nhiên (vd: `shopbot_x7k2p9q`) | Có |
| `FB_APP_SECRET` | Bước 2 (App Secret) | Khuyến nghị |
| `USE_GEMINI` | `true`/`false`, tắt Gemini fallback khi cần chạy rule-only | Không |
| `PUBLIC_BASE_URL` | URL public của app để Messenger lấy ảnh qua `/media` | Không nếu Railway/Render tự có domain |
| `ADMIN_EXPORT_TOKEN` | Chuỗi bí mật để tải CSV/xem debug state | Khuyến nghị |
| `DATA_DIR` | Thư mục lưu state/lead, ví dụ `/data` khi dùng Railway Volume | Không |
| `PORT` | Railway/Render tự set, local dùng `3000` | Không |

### Chạy local

```bash
cp .env.example .env
# mở .env và điền các giá trị bên trên
npm install
npm test
npm run dev
```

### Deploy lên Railway

1. Vào https://railway.app → đăng ký bằng GitHub
2. **New Project → Deploy from GitHub repo** (push code lên GitHub trước)
3. Sau khi deploy: **Settings** → copy domain (`xxx.railway.app`)
4. **Variables** → thêm `FB_PAGE_TOKEN`, `FB_VERIFY_TOKEN`, `FB_APP_SECRET`; thêm `GEMINI_API_KEY` nếu muốn bật Gemini fallback
5. Nếu Railway không tự cấp `RAILWAY_PUBLIC_DOMAIN` hoặc bạn dùng custom domain, thêm `PUBLIC_BASE_URL=https://ten-domain-cua-ban`
6. Nếu muốn lưu lead/state không mất sau restart/deploy: tạo Railway Volume, mount vào `/data`, rồi thêm biến `DATA_DIR=/data`
7. Nếu muốn tải lead/debug session từ trình duyệt, thêm `ADMIN_EXPORT_TOKEN=chuoi_bi_mat_that_dai`

Nếu API Gemini đang free/không ổn định, có thể thêm:

```bash
USE_GEMINI=false
```

Khi đó bot chỉ dùng rule-based và fallback cố định, không gọi Gemini.

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

## TÍNH NĂNG CHÍNH

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
- `shop-config.js` cũng có thể override câu trả lời qua `templates`, không cần sửa `responses.js`

Phần rule xử lý intent nằm trong `rules.js`, template mặc định nằm trong `responses.js`, NLP nằm trong `nlp.js`. `index.js` giữ webhook Messenger, gửi ảnh/tin nhắn, gọi Gemini và các endpoint admin.

Lưu ý: `SYSTEM_PROMPT` của Gemini hiện vẫn được build trong `index.js`. Đây là phần có thể refactor sau nếu muốn bot config-driven 100%.

### Gửi ảnh tự động
Bot tự gửi ảnh khi khách hỏi menu/danh sách/hình/ảnh, nhắc mã sản phẩm, hoặc hỏi keyword như `gel`.

Ảnh được phục vụ qua endpoint:

```txt
GET /media/:filename
```

Cách dùng:

- Điền tên file ảnh vào cột `imageFile` trong `products.csv`.
- Đặt ảnh trong thư mục `images/`, `assets/`, hoặc thư mục cha của project như code hiện tại đang scan.
- Đảm bảo app có URL public qua `PUBLIC_BASE_URL`, `RAILWAY_PUBLIC_DOMAIN`, hoặc `RENDER_EXTERNAL_URL`.

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

### Debug trạng thái khách hàng
Endpoint này giúp xem nhanh session/order draft của một user:

```txt
https://ten-app.up.railway.app/admin/state/USER_ID?token=chuoi_bi_mat_that_dai
```

Kết quả gồm: `inHandoff`, `lastProductCode`, `orderDraft`, `sessionState`, `historyLength`.

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
→ Check log Railway. Thường do thiếu `FB_PAGE_TOKEN`, `FB_VERIFY_TOKEN`, hoặc `GEMINI_API_KEY` khi `USE_GEMINI=true`.
→ Bot cũng có thể đang ở chế độ handoff, đợi 30 phút hoặc xoá `data/chat-state.json`.

❌ **Webhook trả 403**
→ Sai `FB_APP_SECRET` hoặc thiếu chữ ký. Kiểm tra lại App Secret.

❌ **Lỗi Gemini API**
→ Quota hết, key sai, hoặc model đang quá tải. Có thể tạm set `USE_GEMINI=false` để bot chạy rule-only.

❌ **Ảnh không gửi được**
→ Kiểm tra `PUBLIC_BASE_URL` có trỏ đúng domain public không, file ảnh có tồn tại không, và cột `imageFile` trong `products.csv` có đúng tên file không.

---

## CẢNH BÁO

- Sản phẩm thuộc danh mục 18+. Tuân thủ chính sách Meta về quảng cáo và tin nhắn.
- Không đăng nội dung phản cảm trên Page; bot đã được nhắc giữ ngôn ngữ kín đáo nhưng bạn vẫn nên review log định kỳ.
- File `data/` chứa thông tin khách, lịch sử chat, state và processed message IDs. KHÔNG commit lên Git công khai.

---

## FORK BOT NÀY CHO DỰ ÁN/SHOP MỚI

Phần engine đã tách rời khỏi nội dung shop, nên **đa số dự án mới chỉ cần sửa 2 file** là chạy được:

### 1. Sửa `products.csv`
Đổi danh sách sản phẩm (mã, giá, mô tả, ảnh).

```csv
code,price,description,size,weight,gift,preorder,imageFile
MA1,500k,Sản phẩm A,...,,...,false,a.jpg
```

### 2. Sửa `shop-config.js`
File này là "control panel" của bot. Có thể:

- **Đổi tên shop, chính sách, miễn ship, COD, tuổi tối thiểu** ở các trường `shopName`, `policies`, `minAge`.
- **Tắt intent không cần** với `intents.disabled`. VD shop bán đồ trẻ em thì tắt `AGE_POLICY`:

  ```js
  intents: { disabled: ['AGE_POLICY', 'INSPECTION'] }
  ```

- **Thêm intent mới** với `intents.prepend` (ưu tiên cao) hoặc `intents.append` (fallback). Ví dụ shop có voucher:

  ```js
  intents: {
    prepend: [
      {
        name: 'VOUCHER',
        match: ctx => /voucher|ma giam|coupon/.test(ctx.normalized),
        handle: ctx => ctx.render('voucherInfo')
      }
    ]
  }
  ```
  
  Trong handler bạn có thể dùng `ctx.config`, `ctx.products`, `ctx.render`, `ctx.selectedProduct`, `ctx.orderDraft`, `ctx.sessionState`, ...

- **Đổi giọng / câu trả lời** với `templates` (override một phần/toàn bộ template trong `responses.js`):

  ```js
  templates: {
    greeting: 'Chào bạn 🌸 Mình là trợ lý của {{shopName}} đây.',
    voucherInfo: 'Voucher hôm nay: GIAM10K, đơn từ 200k.'
  }
  ```

  Cú pháp template hỗ trợ helpers: `{{price | vnd}}`, `{{name | upper}}`, `{{x | default:'N/A'}}`, có thể chain `{{name | lower | capitalize}}`.

- **Recommendations** có thể để rỗng `[]` cho group nào đó, engine sẽ tự derive từ attributes:
  - `budget`: 3 mã giá thấp nhất
  - `premium`: 3 mã giá cao nhất
  - `large`: mã có size chứa "lớn/to" hoặc weight > 2000g
  - `vibration`: mã có description chứa "rung/pin/sạc"

### 3. (Tuỳ chọn) Sửa `responses.js`
Chỉ cần đụng vào nếu muốn thêm template MỚI (không có trong defaults). Còn override câu cũ thì làm trong `shop-config.templates`.

### 4. (Hiếm) Sửa `nlp.js` / `rules.js`
Chỉ cần khi:
- Thêm slang dictionary mới (ví dụ ngôn ngữ khác): `nlp.js` → `SLANG_RULES`.
- Thêm keyword image kiểu như "gel" cho ngành mới: `rules.js` → hàm `wantsKeywordImage`.
- Thêm built-in detector mới (hiếm khi cần — thường custom intent qua `shop-config.intents.prepend` là đủ).

---

## CHẠY TEST

```bash
npm test
```

Bộ test cover:
- `nlp.js`: normalize, slang, fuzzy match mã sản phẩm, regex địa chỉ, phân biệt câu hỏi.
- `responses.js`: renderTemplate, helpers (vnd/upper/default/...), templates đầy đủ.
- `rules.js`: detector bug-fixes, intent router, state machine 5 trạng thái, custom intents từ config, override template.

Khi sửa rule, chạy `npm test` để biết có vỡ behavior cũ hay không trước khi deploy.

---

## NÂNG CẤP TIẾP THEO (tuỳ chọn)

- Tách `SYSTEM_PROMPT` sang `prompt.js` hoặc cấu hình template riêng nếu muốn config-driven 100%.
- Sync `customers.csv` lên Google Sheet bằng Apps Script.
- Chuyển chat history từ file sang Redis/Postgres khi khách đông.
- Quick Replies trên Messenger (gợi ý nút bấm).
- Khi shop đông >5000 user đồng thời, có thể tăng `LAST_PRODUCT_LRU_LIMIT` trong `rules.js`.

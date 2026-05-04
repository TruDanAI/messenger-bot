# 🚀 ZENBOT SAAS - HỆ THỐNG CHATBOT AI ĐA LUỒNG TỰ ĐỘNG CHỐT ĐƠN

ZenBot không chỉ là một con bot chat thông thường. Đây là một **Nền tảng Phần mềm Dịch vụ (SaaS)** thực thụ, được thiết kế với kiến trúc chịu tải cao để phục vụ **hàng nghìn Fanpage (Shop) cùng một lúc** chỉ với một lõi hệ thống duy nhất.

---

## 💡 HIỂU ĐƠN GIẢN: HỆ THỐNG NÀY LÀM ĐƯỢC GÌ? (Dành cho người ngoài ngành)

Hãy tưởng tượng bạn có 10 cửa hàng khác nhau (bán quần áo, bán mỹ phẩm, bán đồ chơi...). 
Thay vì phải thuê 10 nhân viên trực page, bạn chỉ cần cắm 10 Fanpage này vào ZenBot. 

- **Tiếp khách tự động 24/7:** Khách nhắn tin hỏi giá, hỏi size, hay hỏi tư vấn, bot sẽ tự động đọc hiểu và trả lời cực kỳ tự nhiên như người thật.
- **Tự động xin thông tin chốt đơn:** Khi khách đồng ý mua, bot sẽ khéo léo xin Số Điện Thoại, Tên và Địa chỉ giao hàng.
- **Quản lý đơn hàng tự động:** Khi có đơn mới, bot tự động điền đơn vào **Google Sheets** của công ty và nhắn tin thông báo "TING TING" vào **Telegram** của quản lý.
- **Không bao giờ sập:** Nếu có 10,000 khách nhắn tin cùng 1 giây (như lúc chạy quảng cáo livestream), hệ thống sẽ tự động xếp hàng khách đợi và xử lý cực nhanh mà không bị nghẽn mạng hay sập nguồn.

---

## 🛠 CÔNG NGHỆ BÊN TRONG (Tech Stack & Architecture)

ZenBot được xây dựng bằng kiến trúc **Queue-based Modular Architecture** (Kiến trúc phân rã theo hàng đợi) để đảm bảo tính mở rộng vô hạn.

1. **Webhook Producer (`Express.js`)**: Đóng vai trò là "Người gác cổng". Khi Facebook bắn tin nhắn tới, nó chỉ nhận, đóng gói và thả ngay vào Hàng đợi rồi phản hồi Facebook ngay lập tức (giải quyết triệt để lỗi timeout 15s của Meta).
2. **Message Queue (`BullMQ` + `Redis`)**: Hàng đợi thông minh. Mọi tin nhắn đều nằm trong Redis Queue. Chống thất thoát tin nhắn, tự động thử lại (Retry) nếu lỗi, và chặn tin nhắn rác trùng lặp.
3. **Database Đa Cấu Hình (`MongoDB Atlas`)**: Lưu trữ cấu hình độc lập của từng Shop (Token Facebook, API Key AI, Trạng thái kích hoạt, Gói cước PRO/FREE).
4. **State Management (`Upstash Redis`)**: Đóng vai trò là "Trí nhớ ngắn hạn". Lưu lại luồng chat của khách (Khách này đang chọn mã nào? Đã cho SĐT chưa?) để bot tư vấn liền mạch.
5. **AI Engine (`Gemini 2.5 Flash` + `Rule-based Fallback`)**: Cơ chế lai siêu tốc. 
   - Nếu khách hỏi những câu chốt đơn cơ bản -> Dùng Thuật toán Regex (0.01 giây, tốn 0đ). 
   - Nếu khách hỏi khó/lắt léo -> Gọi AI Gemini vào cuộc tư vấn siêu mượt.
6. **External Integrations**: Tự động đồng bộ Lead (Đơn hàng) sang Google Sheets và cảnh báo qua Telegram.

---

## 📂 CÁCH HỆ THỐNG MULTI-TENANT HOẠT ĐỘNG (Phục vụ nhiều Shop)

Khi có tin nhắn đến từ Fanpage A, hệ thống sẽ:
1. Đọc `Page ID` của Fanpage A.
2. Tra cứu trong **MongoDB** để tìm ra dữ liệu của `Shop A`.
3. Tải **AI Engine độc lập** của riêng Shop A (Bao gồm file `products.csv`, quy tắc bán hàng, hình ảnh sản phẩm) vào bộ nhớ (Caching).
4. AI tư vấn bằng dữ liệu của Shop A.
> Nhờ cấu trúc này, khách của Fanpage Thời trang sẽ không bao giờ bị bot tư vấn nhầm sang sản phẩm của Fanpage Mỹ phẩm!

---

## ⚙️ HƯỚNG DẪN CÀI ĐẶT & TRIỂN KHAI (Dành cho Developer)

### 1. Chuẩn bị môi trường (Biến `.env`)
Tạo file `.env` và điền các thông tin sau:
```env
# 1. MongoDB (Lưu cấu hình Shop)
MONGODB_URI=mongodb+srv://<user>:<pass>@cluster0.xxx.mongodb.net/zenbot_db?retryWrites=true&w=majority

# 2. Redis (Hàng đợi & Trí nhớ bot)
REDIS_URL=rediss://default:<pass>@<region>.upstash.io:6379

# 3. Google Sheets (Xuất đơn hàng)
GOOGLE_SERVICE_ACCOUNT_EMAIL=xxx@yyy.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nXXX...\n-----END PRIVATE KEY-----\n"
GOOGLE_SHEET_ID=1A2B3C4D5E6F7G8H9

# 4. Fallback/Global AI (Phòng khi Shop không nhập API Key)
GEMINI_API_KEY=AIzaSy...
```

### 2. Khởi tạo một Shop mới vào hệ thống
Mỗi shop mới cần 2 thứ:
1. **Dữ liệu Database:** Tạo một record trong MongoDB collection `shops` chứa `fbPageId`, `features`, `credentials`.
2. **Dữ liệu Sản phẩm Local:** Tạo thư mục `shops/<MÃ-SHOP>/` (Ví dụ: `shops/thoi-trang-shop/`) chứa:
   - `products.csv`: File Excel danh sách sản phẩm, giá tiền, ảnh.
   - `config.js`: File cấu hình câu chào, độ tuổi, kịch bản riêng.
   - `images/`: Thư mục chứa ảnh sản phẩm.

### 3. Khởi chạy Local
```bash
npm install
npm run dev
```
Hệ thống sẽ chạy ở port mặc định 8080 (hoặc port do bạn cấu hình).

### 4. Triển khai lên Production (Railway.app)
1. Kết nối kho lưu trữ GitHub của bạn với Railway.
2. Tại Railway, thêm toàn bộ các Biến môi trường (`Variables`) như file `.env`.
3. Bắt buộc thêm biến: `NIXPACKS_NODE_VERSION=20` để Railway chọn đúng môi trường Node.js 20+ (Mongoose 9.x và Crypto yêu cầu Node bản mới).
4. Nhấn Deploy và lấy Domain do Railway cung cấp để cấu hình Webhook trên Facebook.

---

## 💰 CHI PHÍ VẬN HÀNH DỰ KIẾN
*   **Server Hosting (Railway/Render):** ~5$/tháng (Hoặc có thể dùng Free Tier nếu chạy nhỏ).
*   **Database (MongoDB Atlas + Upstash Redis):** Miễn phí (Gói Free Tier dư sức xử lý hàng chục ngàn tin nhắn).
*   **AI (Gemini Flash):** Miễn phí (Rate limit khá cao cho ứng dụng doanh nghiệp nhỏ).
*   **Tổng cộng:** Cực kỳ tối ưu, mô hình Serverless giúp chi phí gần như = 0 nếu không có người dùng.

---

*Hệ thống được thiết kế và tối ưu bởi Kiến trúc sư AI để đáp ứng tiêu chuẩn SaaS thương mại.*

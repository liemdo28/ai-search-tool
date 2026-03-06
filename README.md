# AI Search (Cloudflare Pages)

Web app miễn phí để:
- Nhập từ khóa.
- Thu thập dữ liệu từ nhiều website.
- Tổng hợp thành bảng phân tích ngay trên browser (không cần login người dùng cuối).

## Stack
- Cloudflare Pages + Functions (free tier, kiến trúc duy nhất trong repo).
- SerpAPI để lấy kết quả tìm kiếm.
- OpenAI Responses API để chuẩn hóa dữ liệu thành bảng.

## 1) Chạy local
```bash
npm install
copy .dev.vars.example .dev.vars
```

Điền key vào `.dev.vars`:
- `SERPAPI_API_KEY=...`
- `OPENAI_API_KEY=...`

Chạy:
```bash
npm run dev
```

Mở `http://127.0.0.1:8788`.

## 2) Deploy free lên Cloudflare Pages
1. Push source lên GitHub.
2. Cloudflare Dashboard -> Pages -> Create project -> Connect Git.
3. Build settings:
   - Build command: *(để trống)*
   - Build output directory: `public`
4. Add Environment Variables:
   - `SERPAPI_API_KEY`
   - `OPENAI_API_KEY`
   - `OPENAI_MODEL` = `gpt-4.1-mini` (optional)
   - `SERPAPI_LANG` = `vi` (optional)
   - `SERPAPI_COUNTRY` = `vn` (optional)
5. Deploy.

Sau deploy, web truy cập được ở mọi nơi qua browser, không cần đăng nhập.

## API
- `GET /api/health`
- `POST /api/run`

Body mẫu:
```json
{
  "query": "top 5 trường tiểu học có học phí rẻ nhất HCM",
  "target_sites": 20,
  "top_k": 10,
  "engines": ["google", "bing"]
}
```

## Lưu ý thực tế
- Dữ liệu học phí có thể thay đổi theo năm: luôn kiểm tra lại trên website chính thức của trường.
- Chất lượng bảng phụ thuộc số lượng nguồn và mức độ rõ ràng của thông tin trong nguồn.
- Free tier API có giới hạn request theo ngày/tháng.

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json().catch(() => ({}));
    const query = (body.query || "").toString().trim();
    if (!query) return json({ ok: false, error: "Missing 'query'." }, 400);

    // Accept n_sources from client, fallback to env, clamp 1-10
    const n_sources = clampInt(body.n_sources ?? env.SERPAPI_NUM_RESULTS ?? "5", 1, 10);

    // ── 1) Search via SerpAPI ──────────────────────────────────────────────
    const serpUrl = new URL("https://serpapi.com/search.json");
    serpUrl.searchParams.set("engine", env.SERPAPI_ENGINE || "google");
    serpUrl.searchParams.set("q", query);
    serpUrl.searchParams.set("num", String(n_sources));
    serpUrl.searchParams.set("api_key", env.SERPAPI_API_KEY);
    serpUrl.searchParams.set("hl", "vi");
    serpUrl.searchParams.set("gl", "vn");

    const serpRes = await fetch(serpUrl.toString(), {
      headers: { accept: "application/json" },
    });
    if (!serpRes.ok) {
      const t = await serpRes.text();
      return json({ ok: false, error: "SerpAPI error", status: serpRes.status, detail: t.slice(0, 400) }, 502);
    }

    const serp = await serpRes.json();
    const organic = Array.isArray(serp?.organic_results) ? serp.organic_results : [];
    const items = organic.slice(0, n_sources).map((r) => ({
      title:   r.title   || "",
      link:    r.link    || r.url || "",
      snippet: r.snippet || "",
      source:  r.source  || "",
    })).filter((x) => x.link);

    if (items.length === 0) {
      return json({
        ok: true, query,
        answer: "Mình không tìm thấy kết quả phù hợp.",
        summary: "", columns: [], table_data: [], sources: [], meta: { results: [] },
      });
    }

    // ── 2) Ask AI to return structured table + summary ─────────────────────
    const model = env.OPENAI_MODEL || "gpt-4.1-mini";

    const sourcesText = items.map((it, i) =>
      `[${i + 1}] ${it.title}\nSnippet: ${it.snippet}\nURL: ${it.link}`
    ).join("\n\n");

    const prompt = `Bạn là AI Search Tool chuyên tổng hợp thông tin từ nhiều nguồn web.
Dựa vào câu hỏi và các nguồn bên dưới, hãy trả về JSON hợp lệ (không markdown, không code block, chỉ JSON thuần).

Format bắt buộc:
{
  "summary": "Tóm tắt ngắn gọn bằng tiếng Việt (2-4 câu)",
  "columns": ["Cột 1", "Cột 2", ...],
  "table_data": [
    {"Cột 1": "giá trị", "Cột 2": "giá trị", ...},
    ...
  ]
}

Quy tắc chọn cột:
- Tự động phát hiện loại thông tin phù hợp với câu hỏi.
- Trường học: ["Tên trường", "Địa chỉ", "Học phí", "Link"]
- Nhà hàng / quán ăn: ["Tên quán", "Địa chỉ", "Khoảng giá", "Đánh giá", "Link"]
- Sản phẩm / hàng hóa: ["Tên sản phẩm", "Giá", "Nơi bán", "Link"]
- Danh sách chung: ["Tên", "Mô tả", "Điểm nổi bật", "Link"]
- Luôn có cột "Link" chứa URL thực tế từ danh sách nguồn bên dưới.
- Tối đa 6 cột, tối thiểu 3 cột.
- Tối đa 10 dòng dữ liệu.
- Nếu thiếu thông tin cụ thể, dùng "Không rõ".
- Không bịa thông tin.

Câu hỏi: ${query}

Nguồn:
${sourcesText}

Trả về JSON thuần túy, không thêm bất kỳ ký tự hay giải thích nào khác.`.trim();

    const oaRes = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({ model, input: prompt }),
    });

    if (!oaRes.ok) {
      const t = await oaRes.text();
      return json({ ok: false, error: "OpenAI error", status: oaRes.status, detail: t.slice(0, 400) }, 502);
    }

    const oa = await oaRes.json();
    const rawText = extractText(oa) || "";

    // Parse structured JSON from AI; strip code fences if present
    let tableResult = { summary: "", columns: [], table_data: [] };
    try {
      const cleaned = rawText
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();
      const parsed = JSON.parse(cleaned);
      tableResult = {
        summary:    parsed.summary    || "",
        columns:    Array.isArray(parsed.columns)    ? parsed.columns    : [],
        table_data: Array.isArray(parsed.table_data) ? parsed.table_data : [],
      };
    } catch {
      // AI returned plain text — surface as summary only
      tableResult = { summary: rawText, columns: [], table_data: [] };
    }

    return json({
      ok:         true,
      query,
      answer:     tableResult.summary,
      summary:    tableResult.summary,
      columns:    tableResult.columns,
      table_data: tableResult.table_data,
      sources:    items.map((x) => x.link),
      meta:       { model, results: items },
    });

  } catch (err) {
    return json({ ok: false, error: String(err?.message || err), stack: String(err?.stack || "") }, 500);
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function clampInt(v, min, max) {
  const n = Number.parseInt(String(v), 10);
  if (Number.isNaN(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function extractText(resp) {
  if (typeof resp?.output_text === "string") return resp.output_text;
  const out = resp?.output;
  if (!Array.isArray(out)) return "";
  let buf = "";
  for (const item of out) {
    const content = item?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c?.type === "output_text" && typeof c?.text === "string") buf += c.text;
    }
  }
  return buf.trim();
}

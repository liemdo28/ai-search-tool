const ALLOWED_ENGINES = new Set(["google", "bing", "duckduckgo", "yahoo"]);

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json().catch(() => ({}));
    const query = cleanString(body.query);
    const targetSites = clampInt(body.target_sites, 5, 60, 20);
    const topK = clampInt(body.top_k, 1, 20, 5);
    const engines = normalizeEngines(body.engines);

    if (!query || query.length < 3) {
      return json({ ok: false, error: "Query cần tối thiểu 3 ký tự." }, 400);
    }

    const serpApiKey = cleanString(env.SERPAPI_API_KEY || env.SERAPI_API_KEY);
    if (!serpApiKey) {
      return json(
        {
          ok: false,
          error: "Thiếu SERPAPI_API_KEY (hoặc SERAPI_API_KEY) trên server."
        },
        500
      );
    }

    const lang = cleanString(env.SERPAPI_LANG) || "vi";
    const country = cleanString(env.SERPAPI_COUNTRY) || "vn";
    const baseColumns = inferSchemaFromQuery(query);

    const sources = await collectSources({
      query,
      engines,
      targetSites,
      lang,
      country,
      serpApiKey
    });

    if (sources.length === 0) {
      return json({
        ok: true,
        query,
        engines,
        target_sites: targetSites,
        collected_sites: 0,
        summary: "Không thu thập được nguồn phù hợp từ công cụ tìm kiếm.",
        assumptions: ["Thử đổi từ khóa cụ thể hơn hoặc tăng số website."],
        table: {
          columns: baseColumns,
          rows: []
        },
        sources: []
      });
    }

    const enriched = await enrichSourcesWithContent(sources);
    const synthesized = await synthesizeTable({
      query,
      topK,
      sources: enriched,
      env,
      baseColumns
    });

    return json({
      ok: true,
      query,
      engines,
      target_sites: targetSites,
      collected_sites: enriched.length,
      summary: synthesized.summary,
      assumptions: synthesized.assumptions,
      table: {
        columns: synthesized.columns,
        rows: synthesized.rows.slice(0, topK)
      },
      sources: enriched.map((s, idx) => ({
        id: idx + 1,
        engine: s.engine,
        title: s.title,
        url: s.url,
        snippet: s.snippet
      }))
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: "Lỗi server.",
        detail: String(error && error.message ? error.message : error)
      },
      500
    );
  }
}

async function collectSources({
  query,
  engines,
  targetSites,
  lang,
  country,
  serpApiKey
}) {
  const dedup = new Map();
  const perEngine = Math.max(5, Math.ceil(targetSites / engines.length) + 3);

  for (const engine of engines) {
    let start = 0;
    for (let page = 0; page < 3; page += 1) {
      if (dedup.size >= targetSites) break;
      const batch = await searchSerpApi({
        query,
        engine,
        num: perEngine,
        start,
        lang,
        country,
        serpApiKey
      });
      if (batch.length === 0) break;

      for (const item of batch) {
        if (!item.url || dedup.has(item.url)) continue;
        dedup.set(item.url, item);
        if (dedup.size >= targetSites) break;
      }

      if (batch.length < 4) break;
      start += batch.length;
    }
  }

  return Array.from(dedup.values()).slice(0, targetSites);
}

async function searchSerpApi({
  query,
  engine,
  num,
  start,
  lang,
  country,
  serpApiKey
}) {
  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", engine);
  url.searchParams.set("q", query);
  url.searchParams.set("num", String(num));
  url.searchParams.set("start", String(start));
  url.searchParams.set("hl", lang);
  url.searchParams.set("gl", country);
  url.searchParams.set("api_key", serpApiKey);

  const res = await fetchWithTimeout(url.toString(), { method: "GET" }, 25000);
  if (!res.ok) return [];

  const data = await res.json().catch(() => ({}));
  const organic = Array.isArray(data.organic_results) ? data.organic_results : [];

  return organic
    .map((item) => ({
      engine,
      title: cleanString(item.title),
      url: cleanString(item.link || item.url),
      snippet: cleanString(item.snippet),
      position: item.position
    }))
    .filter((item) => item.url && item.title);
}

async function enrichSourcesWithContent(sources) {
  return runPool(
    sources,
    4,
    async (source) => {
      try {
        const res = await fetchWithTimeout(
          source.url,
          {
            method: "GET",
            headers: {
              accept: "text/html,application/xhtml+xml"
            },
            redirect: "follow"
          },
          18000
        );

        if (!res.ok) return { ...source, content_excerpt: "" };
        const html = await res.text();
        const text = htmlToText(html).slice(0, 2200);
        return { ...source, content_excerpt: text };
      } catch {
        return { ...source, content_excerpt: "" };
      }
    }
  );
}

async function synthesizeTable({ query, topK, sources, env, baseColumns }) {
  const fallbackRows = fallbackRowsFromSources(baseColumns, topK, sources, query);
  const openAiKey = cleanString(env.OPENAI_API_KEY);

  if (!openAiKey) {
    return {
      summary:
        "Đã thu thập nguồn nhưng thiếu OPENAI_API_KEY nên chưa phân tích tự động đầy đủ.",
      assumptions: [
        "Bảng tạm thời được dựng từ title/snippet.",
        "Cấu hình OPENAI_API_KEY để trích xuất dữ liệu chính xác theo ngữ cảnh."
      ],
      columns: baseColumns,
      rows: fallbackRows
    };
  }

  const evidence = sources
    .map(
      (s, i) =>
        `[${i + 1}] Engine: ${s.engine}\nTitle: ${s.title}\nURL: ${s.url}\nSnippet: ${s.snippet}\nExtract: ${s.content_excerpt}`
    )
    .join("\n\n");

  const prompt = `
Bạn là hệ thống tổng hợp dữ liệu từ nhiều website.
Hãy tạo bảng báo cáo linh hoạt theo đúng ý định câu hỏi. Cột của bảng phải phù hợp với truy vấn.

YÊU CẦU:
1) Chỉ dùng dữ liệu có trong nguồn. Không tự bịa.
2) Tên cột và nội dung phải cùng ngữ nghĩa, không lệch nhau.
3) Trả đúng JSON object (không markdown) theo schema:
{
  "summary": "string",
  "assumptions": ["string"],
  "columns": [
    {"key":"snake_case_key","label":"Tên cột hiển thị","type":"text|url"}
  ],
  "rows": [
    {"snake_case_key":"value"}
  ]
}
4) Tối đa ${topK} dòng.
5) Trong columns bắt buộc có cột link nguồn (type="url") và cột ghi chú.
6) Nếu thiếu dữ liệu cho ô nào, để chuỗi rỗng "".

TRUY VẤN:
${query}

NGUỒN:
${evidence}
`.trim();

  try {
    const model = cleanString(env.OPENAI_MODEL) || "gpt-4.1-mini";
    const resp = await fetchWithTimeout(
      "https://api.openai.com/v1/responses",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${openAiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model,
          input: prompt
        })
      },
      45000
    );

    if (!resp.ok) {
      const detail = await resp.text();
      return {
        summary: "Phân tích AI bị lỗi, đang trả bảng tạm từ dữ liệu đã thu thập.",
        assumptions: [truncate(detail, 220)],
        columns: baseColumns,
        rows: fallbackRows
      };
    }

    const data = await resp.json().catch(() => ({}));
    const rawText = extractOutputText(data);
    const parsed = parseJsonObject(rawText);

    if (!parsed || !Array.isArray(parsed.rows)) {
      return {
        summary: "AI trả về sai định dạng JSON, đang dùng bảng tạm từ nguồn.",
        assumptions: ["Prompt đã ép JSON nhưng model trả về chưa chuẩn."],
        columns: baseColumns,
        rows: fallbackRows
      };
    }

    const columns = normalizeColumns(parsed.columns, baseColumns);
    const rows = normalizeRows(parsed.rows, columns, topK);

    return {
      summary: cleanString(parsed.summary) || "Đã tổng hợp từ nguồn thu thập được.",
      assumptions: Array.isArray(parsed.assumptions)
        ? parsed.assumptions.map(cleanString).filter(Boolean).slice(0, 8)
        : [],
      columns,
      rows: rows.length > 0 ? rows : fallbackRowsFromSources(columns, topK, sources, query)
    };
  } catch (error) {
    return {
      summary: "Lỗi khi gọi AI, đang dùng bảng tạm từ dữ liệu nguồn.",
      assumptions: [String(error && error.message ? error.message : error)],
      columns: baseColumns,
      rows: fallbackRows
    };
  }
}

function inferSchemaFromQuery(query) {
  const raw = cleanString(query);
  const q = stripVietnamese(raw).toLowerCase();

  if (
    hasAny(q, [
      "truong",
      "hoc phi",
      "tieu hoc",
      "mam non",
      "hoc sinh",
      "hoc phi"
    ])
  ) {
    return [
      { key: "school_name", label: "Tên trường", type: "text" },
      { key: "address", label: "Địa chỉ", type: "text" },
      { key: "tuition", label: "Học phí", type: "text" },
      { key: "source_url", label: "Link", type: "url" },
      { key: "notes", label: "Ghi chú", type: "text" }
    ];
  }

  if (
    hasAny(q, [
      "xe",
      "oto",
      "o to",
      "xe hoi",
      "doanh so",
      "ban chay",
      "mau xe"
    ])
  ) {
    return [
      { key: "model", label: "Dòng xe", type: "text" },
      { key: "brand", label: "Hãng xe", type: "text" },
      { key: "units_sold", label: "Số lượng bán", type: "text" },
      { key: "revenue", label: "Tổng doanh thu", type: "text" },
      { key: "source_url", label: "Link", type: "url" },
      { key: "notes", label: "Ghi chú", type: "text" }
    ];
  }

  return [
    { key: "item", label: "Đối tượng", type: "text" },
    { key: "metric_1", label: "Chỉ số chính", type: "text" },
    { key: "metric_2", label: "Chỉ số phụ", type: "text" },
    { key: "source_url", label: "Link", type: "url" },
    { key: "notes", label: "Ghi chú", type: "text" }
  ];
}

function normalizeColumns(candidate, fallbackColumns) {
  let rawColumns = Array.isArray(candidate) ? candidate : [];
  if (rawColumns.length === 0) rawColumns = fallbackColumns;

  const used = new Set();
  const normalized = [];

  for (const item of rawColumns) {
    let key = "";
    let label = "";
    let type = "text";

    if (typeof item === "string") {
      label = cleanString(item);
      key = toSnakeKey(label);
    } else if (item && typeof item === "object") {
      key = toSnakeKey(item.key || item.label);
      label = cleanString(item.label) || humanizeKey(key);
      type = cleanString(item.type).toLowerCase() === "url" ? "url" : "text";
    }

    if (!key || used.has(key)) continue;
    if (!label) label = humanizeKey(key);
    if (isUrlField(key, label)) type = "url";

    used.add(key);
    normalized.push({ key, label, type });
  }

  if (normalized.length < 3) {
    return ensureRequiredColumns(fallbackColumns);
  }
  return ensureRequiredColumns(normalized);
}

function ensureRequiredColumns(columns) {
  const out = columns.map((c) => ({
    key: toSnakeKey(c.key),
    label: cleanString(c.label) || humanizeKey(c.key),
    type: cleanString(c.type).toLowerCase() === "url" ? "url" : "text"
  }));

  if (!out.some((c) => isUrlField(c.key, c.label))) {
    out.push({ key: "source_url", label: "Link", type: "url" });
  }
  if (!out.some((c) => isNotesField(c.key, c.label))) {
    out.push({ key: "notes", label: "Ghi chú", type: "text" });
  }

  const used = new Set();
  return out.filter((c) => {
    if (!c.key || used.has(c.key)) return false;
    used.add(c.key);
    return true;
  });
}

function normalizeRows(rowsCandidate, columns, topK) {
  if (!Array.isArray(rowsCandidate)) return [];

  const rows = [];
  for (const rawRow of rowsCandidate) {
    if (!rawRow || typeof rawRow !== "object") continue;
    const normalizedRow = {};

    for (const col of columns) {
      let value = rawRow[col.key];
      if (value == null) value = rawRow[col.label];
      if (value == null && isUrlField(col.key, col.label)) {
        value = rawRow.source_url ?? rawRow.link ?? rawRow.url ?? "";
      }
      normalizedRow[col.key] = cleanCell(value);
    }

    const hasData = columns.some((col) => {
      if (isNotesField(col.key, col.label)) return false;
      return Boolean(normalizedRow[col.key]);
    });
    if (hasData) rows.push(normalizedRow);
    if (rows.length >= topK) break;
  }

  return rows;
}

function fallbackRowsFromSources(columns, topK, sources, query) {
  const rows = [];
  for (const src of sources.slice(0, topK)) {
    const row = {};
    let primaryFilled = false;

    for (const col of columns) {
      if (isUrlField(col.key, col.label)) {
        row[col.key] = src.url || "";
        continue;
      }
      if (isNotesField(col.key, col.label)) {
        row[col.key] = src.snippet || "Thiếu dữ liệu chi tiết từ nguồn.";
        continue;
      }
      if (!primaryFilled) {
        row[col.key] = smartNameFromTitle(src.title, query);
        primaryFilled = true;
      } else {
        row[col.key] = "";
      }
    }
    rows.push(row);
  }
  return rows;
}

async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function runOne() {
    while (true) {
      const idx = cursor;
      cursor += 1;
      if (idx >= items.length) break;
      results[idx] = await worker(items[idx], idx);
    }
  }

  const jobs = [];
  for (let i = 0; i < Math.min(concurrency, items.length); i += 1) {
    jobs.push(runOne());
  }
  await Promise.all(jobs);
  return results;
}

function extractOutputText(resp) {
  if (typeof resp.output_text === "string") return resp.output_text;
  if (!Array.isArray(resp.output)) return "";

  let out = "";
  for (const item of resp.output) {
    if (!Array.isArray(item.content)) continue;
    for (const c of item.content) {
      if (c && c.type === "output_text" && typeof c.text === "string") {
        out += c.text;
      }
    }
  }
  return out.trim();
}

function parseJsonObject(text) {
  if (!text || typeof text !== "string") return null;

  try {
    return JSON.parse(text);
  } catch {}

  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {}
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {}
  }

  return null;
}

function smartNameFromTitle(title, query) {
  const t = cleanString(title);
  if (!t) return cleanString(query);
  const split = t.split(/[|\-–—:]/).map((x) => x.trim()).filter(Boolean);
  return split.length > 0 ? split[0] : t;
}

function htmlToText(html) {
  if (!html) return "";
  let out = html;
  out = out.replace(/<script[\s\S]*?<\/script>/gi, " ");
  out = out.replace(/<style[\s\S]*?<\/style>/gi, " ");
  out = out.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  out = out.replace(/<!--[\s\S]*?-->/g, " ");
  out = out.replace(/<[^>]+>/g, "\n");
  out = decodeHtml(out);
  out = out.replace(/\u00a0/g, " ");
  out = out.replace(/[ \t]+\n/g, "\n");
  out = out.replace(/\n{2,}/g, "\n");
  return out.trim();
}

function decodeHtml(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort("timeout"), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function normalizeEngines(input) {
  const raw = Array.isArray(input) ? input : ["google", "bing"];
  const normalized = raw
    .map((v) => cleanString(v).toLowerCase())
    .filter((v) => ALLOWED_ENGINES.has(v));
  return normalized.length > 0 ? normalized : ["google", "bing"];
}

function hasAny(text, keys) {
  return keys.some((k) => text.includes(k));
}

function stripVietnamese(text) {
  return cleanString(text)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
}

function isUrlField(key, label) {
  const k = `${key} ${label}`.toLowerCase();
  return k.includes("url") || k.includes("link");
}

function isNotesField(key, label) {
  const k = `${key} ${label}`.toLowerCase();
  return k.includes("note") || k.includes("ghi_chu") || k.includes("ghi chu");
}

function toSnakeKey(input) {
  const s = stripVietnamese(String(input || "")).toLowerCase();
  return s
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

function humanizeKey(key) {
  return cleanString(String(key || "").replace(/_/g, " ")) || "Cột";
}

function cleanCell(value) {
  if (value == null) return "";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return cleanString(String(value));
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(String(value), 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function cleanString(value) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim();
}

function truncate(text, maxLen) {
  const t = cleanString(String(text || ""));
  if (t.length <= maxLen) return t;
  return `${t.slice(0, maxLen)}...`;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8"
    }
  });
}

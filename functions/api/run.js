const ALLOWED_ENGINES = new Set(["google", "bing", "duckduckgo", "yahoo"]);

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json().catch(() => ({}));
    const query = cleanString(body.query);
    const targetSites = clampInt(body.target_sites, 1, 60, 20);
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
    const queryType = detectQueryType(query);
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
      baseColumns,
      queryType
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

async function synthesizeTable({
  query,
  topK,
  sources,
  env,
  baseColumns,
  queryType
}) {
  const fallbackTable = buildFallbackTable({
    query,
    topK,
    sources,
    preferredColumns: baseColumns,
    queryType
  });
  const openAiKey = cleanString(env.OPENAI_API_KEY);

  if (!openAiKey) {
    return {
      summary:
        "Đã thu thập nguồn nhưng thiếu OPENAI_API_KEY nên chưa phân tích tự động đầy đủ.",
      assumptions: [
        "Bảng tạm thời được dựng từ title/snippet với schema an toàn.",
        "Cấu hình OPENAI_API_KEY để trích xuất dữ liệu chính xác theo ngữ cảnh."
      ],
      columns: fallbackTable.columns,
      rows: fallbackTable.rows
    };
  }

  const evidenceSources = selectEvidenceSources(sources, query, Math.min(18, Math.max(10, topK * 4)));
  const evidence = evidenceSources
    .map(
      (s, i) =>
        `[${i + 1}] Engine: ${s.engine}\nTitle: ${truncate(s.title, 180)}\nURL: ${s.url}\nSnippet: ${truncate(s.snippet, 380)}\nExtract: ${truncate(s.content_excerpt, 520)}`
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
7) Nếu truy vấn quá rộng hoặc thiếu bằng chứng (ví dụ "toàn thế giới"/"trái đất"), ghi rõ trong summary là chưa đủ bằng chứng để kết luận tuyệt đối.

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
          input: prompt,
          temperature: 0.2,
          max_output_tokens: 1800
        })
      },
      65000
    );

    if (!resp.ok) {
      const detail = await resp.text();
      const friendly = toFriendlyAiError(detail);
      return {
        summary: "Phân tích AI bị lỗi, đang trả bảng tạm từ dữ liệu đã thu thập.",
        assumptions: [friendly],
        columns: fallbackTable.columns,
        rows: fallbackTable.rows
      };
    }

    const data = await resp.json().catch(() => ({}));
    const rawText = extractOutputText(data);
    const parsed = parseJsonObject(rawText);

    if (!parsed || !Array.isArray(parsed.rows)) {
      return {
        summary: "AI trả về sai định dạng JSON, đang dùng bảng tạm từ nguồn.",
        assumptions: ["Prompt đã ép JSON nhưng model trả về chưa chuẩn."],
        columns: fallbackTable.columns,
        rows: fallbackTable.rows
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
      rows:
        rows.length > 0
          ? rows
          : buildFallbackTable({
              query,
              topK,
              sources,
              preferredColumns: columns,
              queryType
            }).rows
    };
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    return {
      summary: "Lỗi khi gọi AI, đang dùng bảng tạm từ dữ liệu nguồn.",
      assumptions: [toFriendlyAiError(message)],
      columns: fallbackTable.columns,
      rows: fallbackTable.rows
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
      "hoc phi",
      "dai hoc",
      "hoc vien",
      "university",
      "college"
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

function buildFallbackTable({
  query,
  topK,
  sources,
  preferredColumns,
  queryType
}) {
  const ranked = selectEvidenceSources(sources, query, Math.max(topK * 3, 12));
  const rowsUsingPreferred = fallbackRowsFromSources(
    preferredColumns,
    topK,
    ranked,
    query,
    queryType
  );
  const quality = estimateTableQuality(
    preferredColumns,
    rowsUsingPreferred,
    queryType
  );
  const threshold = queryType === "vehicle" ? 0.58 : queryType === "school" ? 0.68 : 0.4;

  if (quality >= threshold) {
    return { columns: preferredColumns, rows: rowsUsingPreferred };
  }

  const safeColumns =
    queryType === "vehicle"
      ? [
          { key: "model", label: "Dòng xe", type: "text" },
          { key: "brand", label: "Hãng xe", type: "text" },
          { key: "evidence", label: "Thông tin trích từ nguồn", type: "text" },
          { key: "source_url", label: "Link", type: "url" },
          { key: "notes", label: "Ghi chú", type: "text" }
        ]
      : queryType === "school"
      ? [
          { key: "school_name", label: "Tên trường", type: "text" },
          { key: "address", label: "Địa chỉ", type: "text" },
          { key: "evidence", label: "Thông tin trích từ nguồn", type: "text" },
          { key: "source_url", label: "Link", type: "url" },
          { key: "notes", label: "Ghi chú", type: "text" }
        ]
      : [
          { key: "item", label: "Mục tìm thấy", type: "text" },
          { key: "evidence", label: "Thông tin trích từ nguồn", type: "text" },
          { key: "source_url", label: "Link", type: "url" },
          { key: "notes", label: "Ghi chú", type: "text" }
        ];
  return {
    columns: safeColumns,
    rows: fallbackRowsFromSources(safeColumns, topK, ranked, query, queryType)
  };
}

function fallbackRowsFromSources(columns, topK, sources, query, queryType) {
  const rows = [];
  const seenSchoolKeys = new Set();
  const schoolLocationHints =
    queryType === "school" ? extractLocationHints(query) : [];
  const rankingSchoolQuery = queryType === "school" && isRankingQuery(query);
  const schoolCol = queryType === "school" ? findSchoolColumn(columns) : null;

  for (const src of sources) {
    if (rows.length >= topK) break;

    const row = {};
    const richText = `${src.title}\n${src.snippet}\n${src.content_excerpt}`.trim();
    const vehicle = extractVehicleEntity(richText);
    const schoolName = extractSchoolName(src.title, src.snippet, src.content_excerpt);
    const schoolCandidates = rankingSchoolQuery
      ? extractSchoolCandidates(richText)
      : [];

    for (const col of columns) {
      if (isUrlField(col.key, col.label)) {
        row[col.key] = src.url || "";
        continue;
      }
      if (isNotesField(col.key, col.label)) {
        row[col.key] = src.snippet || "Thiếu dữ liệu chi tiết từ nguồn.";
        continue;
      }

      const hint = `${col.key} ${col.label}`.toLowerCase();
      if (
        hint.includes("school") ||
        hint.includes("ten_truong") ||
        hint.includes("tên trường") ||
        /\btruong\b/.test(stripVietnamese(hint))
      ) {
        row[col.key] = schoolName;
        continue;
      }
      if (hint.includes("item") || hint.includes("muc") || hint.includes("model")) {
        if (queryType === "vehicle") {
          row[col.key] = vehicle.model || "";
        } else {
          row[col.key] = smartNameFromTitle(src.title, query);
        }
        continue;
      }
      if (hint.includes("brand") || hint.includes("hang")) {
        row[col.key] = vehicle.brand || extractBrand(richText);
        continue;
      }
      if (
        hint.includes("quantity") ||
        hint.includes("so_luong") ||
        hint.includes("units")
      ) {
        row[col.key] = extractUnitsSold(richText, queryType);
        continue;
      }
      if (
        hint.includes("doanh_thu") ||
        hint.includes("revenue")
      ) {
        row[col.key] = extractRevenueOnly(richText);
        continue;
      }
      if (hint.includes("gia") || hint.includes("price")) {
        row[col.key] = extractMoney(richText);
        continue;
      }
      if (hint.includes("dia_chi") || hint.includes("address")) {
        row[col.key] = extractAddress(richText);
        continue;
      }
      if (hint.includes("hoc_phi") || hint.includes("tuition")) {
        row[col.key] = extractTuition(richText);
        continue;
      }
      if (hint.includes("evidence") || hint.includes("thong_tin")) {
        row[col.key] = truncate(src.snippet || src.content_excerpt, 260);
        continue;
      }

      row[col.key] = "";
    }

    if (queryType === "vehicle") {
      enforceVehicleRowStrictness(row, columns, richText);
    }
    if (queryType === "school") {
      enforceSchoolRowStrictness(row, columns, richText);

      let school =
        cleanString(row.school_name || row.ten_truong || row["tên trường"] || "");

      if (school && schoolCol) {
        if (!schoolRowMatchesQuery(row, src, schoolLocationHints, query)) {
          school = "";
        }
      }

      if (school) {
        const key = schoolDedupKey(school);
        if (key && !seenSchoolKeys.has(key)) {
          seenSchoolKeys.add(key);
          rows.push(row);
        }
      } else if (rankingSchoolQuery && schoolCol && schoolCandidates.length > 0) {
        for (const candidate of schoolCandidates) {
          if (rows.length >= topK) break;
          const key = schoolDedupKey(candidate);
          if (!key || seenSchoolKeys.has(key)) continue;

          const candidateRow = { ...row, [schoolCol.key]: candidate };
          enforceSchoolRowStrictness(candidateRow, columns, richText);
          if (
            !schoolRowMatchesQuery(candidateRow, src, schoolLocationHints, query)
          ) {
            continue;
          }

          seenSchoolKeys.add(key);
          rows.push(candidateRow);
        }
      }
      continue;
    }

    rows.push(row);
  }
  return rows;
}

function selectEvidenceSources(sources, query, limit) {
  const tokens = queryTokens(query);
  const scored = sources
    .map((s) => ({
      ...s,
      _score: relevanceScore(s, tokens)
    }))
    .sort((a, b) => b._score - a._score);

  const selected = [];
  const domains = new Map();
  for (const item of scored) {
    if (selected.length >= limit) break;
    const domain = extractDomain(item.url);
    const count = domains.get(domain) || 0;
    if (count >= 2) continue;
    domains.set(domain, count + 1);
    selected.push(item);
  }

  return selected.length > 0 ? selected : sources.slice(0, limit);
}

function estimateTableQuality(columns, rows, queryType) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  const candidateCols = columns.filter(
    (c) => !isUrlField(c.key, c.label) && !isNotesField(c.key, c.label)
  );
  if (candidateCols.length === 0) return 0;

  let points = 0;
  for (const row of rows) {
    for (const col of candidateCols) {
      const value = cleanString(row[col.key] || "");
      if (value) points += 1;
    }
  }
  let base = points / (rows.length * candidateCols.length);

  if (queryType === "vehicle") {
    let penalties = 0;
    for (const row of rows) {
      const model = cleanString(row.model || row.dong_xe || "");
      const units = cleanString(row.units_sold || row.so_luong_ban || "");
      const revenue = cleanString(row.revenue || row.tong_doanh_thu || "");

      if (model && looksLikeArticleTitle(model)) penalties += 0.4;
      if (isLikelyYear(units)) penalties += 0.25;
      if (revenue && !looksLikeRevenueValue(revenue)) penalties += 0.2;
    }
    base = Math.max(0, base - penalties / Math.max(1, rows.length));
  }
  if (queryType === "school") {
    let penalties = 0;
    for (const row of rows) {
      const school = cleanString(row.school_name || row.ten_truong || "");
      const tuition = cleanString(row.tuition || row.hoc_phi || "");
      const address = cleanString(row.address || row.dia_chi || "");

      if (school && !looksLikeSchoolName(school)) penalties += 0.35;
      if (tuition && !looksLikeTuitionValue(tuition)) penalties += 0.25;
      if (address && !looksLikeAddressValue(address)) penalties += 0.2;
    }
    base = Math.max(0, base - penalties / Math.max(1, rows.length));
  }

  return base;
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

function detectQueryType(query) {
  const q = stripVietnamese(query).toLowerCase();
  if (
    hasAny(q, [
      "xe",
      "oto",
      "o to",
      "xe hoi",
      "mau xe",
      "doanh so",
      "ban chay"
    ])
  ) {
    return "vehicle";
  }
  if (
    hasAny(q, [
      "truong",
      "hoc phi",
      "tieu hoc",
      "mam non",
      "hoc sinh",
      "dia chi",
      "dai hoc",
      "hoc vien",
      "university",
      "college"
    ])
  ) {
    return "school";
  }
  return "generic";
}

function queryTokens(query) {
  const stopWords = new Set([
    "top",
    "nhat",
    "re",
    "tot",
    "la",
    "cho",
    "cua",
    "tai",
    "o",
    "the",
    "gioi",
    "trai",
    "dat",
    "nam"
  ]);

  return stripVietnamese(query)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !stopWords.has(t));
}

function relevanceScore(source, tokens) {
  const hay = stripVietnamese(
    `${source.title} ${source.snippet} ${source.content_excerpt || ""}`
  ).toLowerCase();

  let score = 0;
  for (const token of tokens) {
    if (!token) continue;
    if (hay.includes(token)) score += 2;
  }

  const badHints = ["quang cao", "advertisement", "shop", "mua ngay"];
  for (const hint of badHints) {
    if (hay.includes(hint)) score -= 1;
  }

  if (source.title) score += 1;
  if (source.snippet) score += 1;
  if (source.content_excerpt) score += 1;
  return score;
}

function extractDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
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

function enforceVehicleRowStrictness(row, columns, richText) {
  const modelCol = columns.find((c) =>
    /model|dong_xe|dong xe|xe/i.test(`${c.key} ${c.label}`)
  );
  const brandCol = columns.find((c) =>
    /brand|hang_xe|hang xe/i.test(`${c.key} ${c.label}`)
  );
  const unitsCol = columns.find((c) =>
    /units|so_luong|so luong|quantity/i.test(`${c.key} ${c.label}`)
  );
  const revenueCol = columns.find((c) =>
    /revenue|doanh_thu|doanh thu/i.test(`${c.key} ${c.label}`)
  );

  if (modelCol) {
    const model = cleanString(row[modelCol.key] || "");
    if (!isValidVehicleModel(model)) {
      row[modelCol.key] = "";
      if (brandCol) row[brandCol.key] = "";
    }
  }

  if (unitsCol) {
    const units = cleanString(row[unitsCol.key] || "");
    if (!isPlausibleUnitsSold(units, richText)) {
      row[unitsCol.key] = "";
    }
  }

  if (revenueCol) {
    const revenue = cleanString(row[revenueCol.key] || "");
    if (revenue && !looksLikeRevenueValue(revenue)) {
      row[revenueCol.key] = "";
    }
  }
}

function extractMoney(text) {
  const t = cleanString(text);
  const patterns = [
    /(\d[\d.,]*)\s*(ty|tỷ)\b/i,
    /(\d[\d.,]*)\s*(trieu|triệu)\b/i,
    /(\d[\d.,]*)\s*(nghin|nghìn)\b/i,
    /(\d[\d.,]*)\s*(vnd|vnđ|dong)\b/i
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) return `${m[1]} ${m[2]}`.trim();
  }
  return "";
}

function extractTuition(text) {
  const t = cleanString(text);
  const patterns = [
    /(hoc phi|học phí|tuition|fee)[^0-9]{0,24}(\d[\d.,]*(?:\s*[-~tođến]+\s*\d[\d.,]*)?\s*(ty|tỷ|trieu|triệu|nghin|nghìn|vnd|vnđ|dong))(?:\s*\/?\s*(thang|tháng|nam|năm))?/i,
    /(\d[\d.,]*(?:\s*[-~tođến]+\s*\d[\d.,]*)?\s*(ty|tỷ|trieu|triệu|nghin|nghìn|vnd|vnđ|dong))(?:\s*\/?\s*(thang|tháng|nam|năm))?[^a-z0-9]{0,20}(hoc phi|học phí|tuition|fee)/i
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (!m) continue;
    const amount = cleanString(m[2] || m[1] || "");
    const period = cleanString(m[4] || m[3] || "");
    return period ? `${amount}/${period}` : amount;
  }
  return "";
}

function extractRevenueOnly(text) {
  const t = cleanString(text);
  const patterns = [
    /(doanh thu|revenue)[^0-9]{0,20}(\d[\d.,]*\s*(ty|tỷ|trieu|triệu|usd|vnd|đ|dong))/i,
    /(\d[\d.,]*\s*(ty|tỷ|trieu|triệu|usd|vnd|đ|dong))[^a-z0-9]{0,12}(doanh thu|revenue)/i
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (!m) continue;
    const money = cleanString(m[2] || m[1] || "");
    if (money) return money;
  }
  return "";
}

function extractUnitsSold(text, queryType = "generic") {
  const t = cleanString(text);
  const direct = Array.from(t.matchAll(/(\d[\d.,]*)\s*(xe|chiếc|chiec|units?)\b/gi));
  for (const m of direct) {
    const raw = cleanString(m[1] || "");
    const num = toNumericInt(raw);
    if (!num) continue;
    if (queryType === "vehicle") {
      if (isLikelyYear(raw)) continue;
      const idx = m.index || 0;
      const context = t.slice(Math.max(0, idx - 18), idx + 18).toLowerCase();
      if (/(top|xep hang|xếp hạng|hang|thứ)/i.test(context) && num <= 20) continue;
      if (num <= 20) continue; // tránh lấy "top 10"
      if (num > 3000000) continue;
    }
    return raw;
  }

  const hinted = Array.from(
    t.matchAll(/(?:doanh so|sales?|ban duoc|sold)[^0-9]{0,20}(\d[\d.,]*)/gi)
  );
  for (const m of hinted) {
    const raw = cleanString(m[1] || "");
    const num = toNumericInt(raw);
    if (!num) continue;
    if (queryType === "vehicle" && (isLikelyYear(raw) || num <= 20)) continue;
    return raw;
  }

  return "";
}

function extractAddress(text) {
  const t = cleanString(text);
  const patterns = [
    /(dia chi|địa chỉ)\s*[:\-]?\s*([^.;|]{8,140})/i,
    /(\d{1,4}[^,;|]{3,120}(quan|q\.|district|huyen|phuong)[^,;|]{0,80})/i,
    /((?:phuong|phường)\s*[^,;|]{2,40}(?:\s*[-,]\s*(?:quan|quận|q\.)\s*[^,;|]{1,20})?(?:\s*[-,]\s*(?:tp\.?\s*hcm|tp\.?\s*ho chi minh|ho chi minh))?)/i
  ];
  let out = "";
  for (const re of patterns) {
    const m = t.match(re);
    if (!m) continue;
    out = cleanString(m[2] || m[1] || "");
    if (out) break;
  }
  if (!out) return "";
  if (!looksLikeAddressValue(out)) return "";
  return out;
}

function extractBrand(text) {
  const t = stripVietnamese(text).toLowerCase();
  const brands = [
    "toyota",
    "honda",
    "hyundai",
    "ford",
    "kia",
    "mazda",
    "bmw",
    "mercedes",
    "audi",
    "tesla",
    "vinfast",
    "mitsubishi",
    "nissan",
    "isuzu"
  ];
  for (const b of brands) {
    if (t.includes(b)) return b.toUpperCase();
  }
  return "";
}

function extractVehicleEntity(text) {
  const cleaned = cleanString(text);
  const brands = [
    "TOYOTA",
    "HONDA",
    "HYUNDAI",
    "FORD",
    "KIA",
    "MAZDA",
    "BMW",
    "MERCEDES",
    "AUDI",
    "TESLA",
    "VINFAST",
    "MITSUBISHI",
    "NISSAN",
    "ISUZU"
  ];

  // Common standalone model hints first (high precision).
  const known = [
    ["VINFAST", /(?:\bVF\s?3\b|\bVF\s?5\b|\bVF\s?6\b|\bVF\s?7\b|\bVF\s?8\b)/i],
    ["MAZDA", /\b(CX-3|CX-5|CX-8|MAZDA\s?2|MAZDA\s?3|MAZDA\s?6)\b/i],
    ["TOYOTA", /\b(VIOS|FORTUNER|INNOVA|COROLLA|CAMRY|YARIS)\b/i],
    ["HYUNDAI", /\b(ACCENT|TUCSON|SANTA\s?FE|CRETA)\b/i],
    ["KIA", /\b(SELTOS|SONET|K3|CARNIVAL)\b/i],
    ["HONDA", /\b(CITY|CIVIC|CR-V|HR-V)\b/i],
    ["FORD", /\b(RANGER|EVEREST|TERRITORY)\b/i]
  ];

  for (const [brand, re] of known) {
    const m = cleaned.match(re);
    if (!m) continue;
    const token = cleanString(m[1] || m[0]).toUpperCase();
    if (!isValidVehicleModel(`${brand} ${token}`)) continue;
    return { brand, model: `${brand} ${token}`.replace(/\s+/g, " ").trim() };
  }

  // Generic pattern as fallback.
  for (const brand of brands) {
    const re = new RegExp(
      `\\b${brand}\\s+([A-Z0-9]{2,10}(?:-[A-Z0-9]{1,6})?(?:\\s+[A-Z0-9]{2,10}(?:-[A-Z0-9]{1,6})?)?)\\b`,
      "i"
    );
    const m = cleaned.match(re);
    if (!m) continue;
    const rawPart = cleanString(m[1]).toUpperCase();
    const modelPart = cleanVehicleModelPart(rawPart);
    const candidate = `${brand} ${modelPart}`.replace(/\s+/g, " ").trim();
    if (!isValidVehicleModel(candidate)) continue;
    return { brand, model: candidate };
  }

  return { brand: "", model: "" };
}

function looksLikeNonModelToken(value) {
  const v = stripVietnamese(value).toLowerCase();
  return hasAny(v, [
    "top",
    "thang",
    "nam",
    "ban",
    "chay",
    "nhat",
    "xe",
    "oto",
    "th",
    "nh"
  ]);
}

function looksLikeArticleTitle(value) {
  const v = stripVietnamese(value).toLowerCase();
  return (
    v.split(/\s+/).length >= 4 &&
    hasAny(v, ["top", "thang", "nam", "ban chay", "xep hang", "thi truong"])
  );
}

function looksLikeRevenueValue(value) {
  const v = stripVietnamese(value).toLowerCase();
  if (!/\d/.test(v)) return false;
  return hasAny(v, ["ty", "trieu", "usd", "vnd", "dong", "đ"]);
}

function isLikelyYear(value) {
  const n = toNumericInt(value);
  return n >= 1900 && n <= 2099;
}

function cleanVehicleModelPart(part) {
  let p = cleanString(part).toUpperCase();
  p = p.replace(/\b(19|20)\d{2}\b/g, "").trim();
  p = p.replace(/[^\w\s-]/g, " ").replace(/\s+/g, " ").trim();
  return p;
}

function isValidVehicleModel(model) {
  const m = cleanString(model).toUpperCase();
  if (!m) return false;
  const tokens = m.split(/\s+/);
  if (tokens.length < 2) return false;

  const modelTokens = tokens.slice(1).filter(Boolean);
  if (modelTokens.length === 0) return false;

  const bad = new Set(["V", "B", "X", "TH", "NH", "TOP", "XE", "OTO", "NAM", "THANG"]);
  let hasMeaningful = false;
  for (const tok of modelTokens) {
    if (bad.has(tok)) return false;
    if (isLikelyYear(tok)) return false;
    if (tok.length >= 2 || /\d/.test(tok)) hasMeaningful = true;
  }
  if (!hasMeaningful) return false;
  if (looksLikeArticleTitle(m)) return false;
  return true;
}

function isPlausibleUnitsSold(units, richText = "") {
  const raw = cleanString(units);
  if (!raw) return false;
  if (isLikelyYear(raw)) return false;

  const n = toNumericInt(raw);
  if (!n) return false;
  if (n <= 20) return false;
  if (n > 3000000) return false;

  const near = stripVietnamese(richText).toLowerCase();
  if (near.includes("top 10") && n === 10) return false;
  return true;
}

function extractSchoolName(title, snippet = "", content = "") {
  const text = `${title}\n${snippet}\n${content}`;
  const patterns = [
    /(trường\s+(?:tiểu học|mẫu giáo|mầm non|thcs|thpt|quốc tế)[^,.;|\n]{2,100})/gi,
    /(truong\s+(?:tieu hoc|mau giao|mam non|thcs|thpt|quoc te)[^,.;|\n]{2,100})/gi
  ];

  for (const re of patterns) {
    const matches = Array.from(text.matchAll(re));
    for (const m of matches) {
      const candidate = cleanSchoolNameCandidate(cleanString(m[1] || m[0] || ""));
      if (looksLikeSchoolName(candidate)) return candidate;
    }
  }

  const base = cleanSchoolNameCandidate(smartNameFromTitle(title, ""));
  return looksLikeSchoolName(base) ? base : "";
}

function enforceSchoolRowStrictness(row, columns, richText = "") {
  const schoolCol = columns.find((c) =>
    /school|ten_truong|tên trường|truong/i.test(`${c.key} ${c.label}`)
  );
  const tuitionCol = columns.find((c) =>
    /tuition|hoc_phi|học phí/i.test(`${c.key} ${c.label}`)
  );
  const addressCol = columns.find((c) =>
    /address|dia_chi|địa chỉ/i.test(`${c.key} ${c.label}`)
  );

  if (schoolCol) {
    const school = cleanSchoolNameCandidate(cleanString(row[schoolCol.key] || ""));
    if (school && !looksLikeSchoolName(school)) {
      row[schoolCol.key] = "";
    } else {
      row[schoolCol.key] = school;
    }
  }
  if (tuitionCol) {
    const tuition = cleanString(row[tuitionCol.key] || "");
    if (tuition && !looksLikeTuitionValue(tuition)) {
      row[tuitionCol.key] = "";
    }
  }
  if (addressCol) {
    let address = cleanString(row[addressCol.key] || "");
    if (!address && richText) {
      address = extractAddress(richText);
    }
    if (address && !looksLikeAddressValue(address)) {
      row[addressCol.key] = "";
    } else {
      row[addressCol.key] = address;
    }
  }
}

function looksLikeSchoolName(value) {
  const v = stripVietnamese(value).toLowerCase();
  if (!v) return false;
  if (
    !hasAny(v, [
      "truong",
      "thcs",
      "thpt",
      "mam non",
      "tieu hoc",
      "dai hoc",
      "hoc vien",
      "university",
      "college"
    ])
  ) {
    return false;
  }
  if (
    hasAny(v, [
      "top ",
      "tot nhat",
      "moi nhat",
      "xep hang",
      "danh sach",
      "danh muc",
      "tat ca",
      "cac truong",
      "truong hoc tai",
      "tuyen sinh",
      "tai duong",
      "tai cau"
    ])
  ) {
    return false;
  }
  const tokenCount = v.split(/\s+/).filter(Boolean).length;
  return tokenCount >= 3;
}

function looksLikeTuitionValue(value) {
  const v = stripVietnamese(value).toLowerCase();
  return /\d/.test(v) && hasAny(v, ["trieu", "nghin", "ty", "vnd", "vnđ", "dong"]);
}

function looksLikeAddressValue(value) {
  const v = stripVietnamese(value).toLowerCase();
  if (v.length < 8) return false;
  return hasAny(v, [
    "quan",
    "q.",
    "phuong",
    "duong",
    "tp",
    "hcm",
    "ho chi minh",
    "district",
    "ward"
  ]);
}

function cleanSchoolNameCandidate(value) {
  let v = cleanString(value);
  if (!v) return "";
  v = v.replace(/\s*[-|–—]\s*(phường|phuong|quận|quan|tp|tp\.|hcm|ho chi minh).*/i, "");
  v = v.replace(/\s{2,}/g, " ").trim();
  return v;
}

function schoolDedupKey(value) {
  const v = stripVietnamese(cleanSchoolNameCandidate(value)).toLowerCase();
  return v
    .replace(/\b(truong|tieu|hoc|mam|non|thcs|thpt|quoc|te)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function extractLocationHints(query) {
  const q = stripVietnamese(query).toLowerCase();
  const out = [];
  const patterns = [
    /\bphuong\s+[a-z0-9]+(?:\s+[a-z0-9]+){0,2}\b/g,
    /\bquan\s+\d{1,2}\b/g,
    /\bquan\s+[a-z0-9]+(?:\s+[a-z0-9]+){0,1}\b/g,
    /\bhcm\b/g,
    /\bho chi minh\b/g
  ];

  for (const re of patterns) {
    const matches = q.match(re) || [];
    for (const m of matches) {
      const hint = cleanString(m);
      if (!hint) continue;
      if (!out.includes(hint)) out.push(hint);
    }
  }
  return out;
}

function schoolRowMatchesQuery(row, source, locationHints, query = "") {
  const school = cleanString(row.school_name || row.ten_truong || "");
  if (!looksLikeSchoolName(school)) return false;

  const hay = stripVietnamese(
    `${school}\n${row.address || ""}\n${source.title || ""}\n${source.snippet || ""}\n${source.content_excerpt || ""}`
  ).toLowerCase();
  const rankingQuery = isRankingQuery(query);

  if (
    !rankingQuery &&
    (looksLikeSchoolListPage(school) || looksLikeSchoolListPage(source.title || ""))
  ) {
    return false;
  }

  if (!Array.isArray(locationHints) || locationHints.length === 0) return true;

  // If query mentions a specific ward/district, keep only rows matching at least one hint.
  return locationHints.some((hint) => hay.includes(hint));
}

function looksLikeSchoolListPage(value) {
  const v = stripVietnamese(cleanString(value)).toLowerCase();
  return hasAny(v, [
    "danh muc",
    "danh sach",
    "top ",
    "tat ca",
    "cac truong",
    "truong hoc tai",
    "xep hang"
  ]);
}

function findSchoolColumn(columns) {
  return columns.find((c) =>
    /school|ten_truong|tên trường|truong/i.test(`${c.key} ${c.label}`)
  );
}

function isRankingQuery(query) {
  const q = stripVietnamese(query).toLowerCase();
  return hasAny(q, [
    "top ",
    "hang dau",
    "tot nhat",
    "xep hang",
    "ranking",
    "best",
    "noi bat"
  ]);
}

function extractSchoolCandidates(text) {
  const t = cleanString(text);
  const patterns = [
    /(?:^|\n|\s)(?:\d{1,2}[.)-]?\s*)(trường\s+(?:đại học|cao đẳng|học viện|tiểu học|thcs|thpt)[^,.;|\n]{2,90})/gi,
    /(?:^|\n|\s)(?:\d{1,2}[.)-]?\s*)(truong\s+(?:dai hoc|cao dang|hoc vien|tieu hoc|thcs|thpt)[^,.;|\n]{2,90})/gi
  ];

  const out = [];
  const seen = new Set();
  for (const re of patterns) {
    const matches = Array.from(t.matchAll(re));
    for (const m of matches) {
      const raw = cleanSchoolNameCandidate(cleanString(m[1] || m[0] || ""));
      if (!looksLikeSchoolName(raw)) continue;
      const key = schoolDedupKey(raw);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(raw);
      if (out.length >= 12) return out;
    }
  }
  return out;
}

function toFriendlyAiError(raw) {
  const text = cleanString(String(raw || ""));
  if (!text) return "Không thể phân tích AI ở thời điểm hiện tại.";
  const lower = text.toLowerCase();
  if (lower.includes("unsupported_country_region_territory")) {
    return "AI provider đang từ chối theo region hiện tại. Hệ thống đã chuyển sang bảng tạm từ nguồn search.";
  }
  if (lower.includes("rate limit") || lower.includes("quota")) {
    return "AI provider đang giới hạn request/quota. Hệ thống đã chuyển sang bảng tạm từ nguồn search.";
  }
  if (lower.includes("timeout")) {
    return "AI provider timeout. Hệ thống đã chuyển sang bảng tạm từ nguồn search.";
  }
  return truncate(text, 180);
}

function toNumericInt(value) {
  const n = Number.parseInt(String(value || "").replace(/[^\d]/g, ""), 10);
  return Number.isNaN(n) ? 0 : n;
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

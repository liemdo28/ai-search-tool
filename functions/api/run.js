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

    if (!env.SERPAPI_API_KEY) {
      return json(
        { ok: false, error: "Thiếu SERPAPI_API_KEY trên server." },
        500
      );
    }

    const lang = cleanString(env.SERPAPI_LANG) || "vi";
    const country = cleanString(env.SERPAPI_COUNTRY) || "vn";

    const sources = await collectSources({
      query,
      engines,
      targetSites,
      lang,
      country,
      serpApiKey: env.SERPAPI_API_KEY
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
        table: [],
        sources: []
      });
    }

    const enriched = await enrichSourcesWithContent(sources);
    const synthesized = await synthesizeTable({
      query,
      topK,
      sources: enriched,
      env
    });

    return json({
      ok: true,
      query,
      engines,
      target_sites: targetSites,
      collected_sites: enriched.length,
      summary: synthesized.summary,
      assumptions: synthesized.assumptions,
      table: synthesized.rows.slice(0, topK).map((row, idx) => ({
        rank: idx + 1,
        name: row.name || "",
        address: row.address || "",
        tuition: row.tuition || "",
        source_url: row.source_url || "",
        notes: row.notes || ""
      })),
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

async function synthesizeTable({ query, topK, sources, env }) {
  const fallback = fallbackRowsFromSources(query, topK, sources);

  if (!env.OPENAI_API_KEY) {
    return {
      summary:
        "Đã thu thập nguồn nhưng thiếu OPENAI_API_KEY nên chưa phân tích tự động đầy đủ.",
      assumptions: [
        "Bảng tạm thời được dựng từ title/snippet.",
        "Cấu hình OPENAI_API_KEY để trích xuất học phí và địa chỉ chính xác hơn."
      ],
      rows: fallback
    };
  }

  const evidence = sources
    .map(
      (s, i) =>
        `[${i + 1}] Engine: ${s.engine}\nTitle: ${s.title}\nURL: ${s.url}\nSnippet: ${s.snippet}\nExtract: ${s.content_excerpt}`
    )
    .join("\n\n");

  const prompt = `
Bạn là hệ thống phân tích dữ liệu từ nhiều website.
Nhiệm vụ: với câu hỏi của người dùng, tạo bảng top ${topK} kết quả phù hợp nhất dựa trên nguồn bên dưới.

QUY TẮC:
1) Chỉ dùng dữ liệu có trong nguồn. Không suy diễn khi thiếu bằng chứng.
2) Nếu không tìm thấy địa chỉ hoặc học phí, để chuỗi rỗng "".
3) Ưu tiên các mục có thông tin học phí rõ ràng.
4) Trả đúng JSON object, không thêm markdown:
{
  "summary": "string",
  "assumptions": ["string"],
  "rows": [
    {
      "name": "string",
      "address": "string",
      "tuition": "string",
      "source_url": "string",
      "notes": "string"
    }
  ]
}
5) rows tối đa ${topK} phần tử.

CÂU HỎI: ${query}

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
          authorization: `Bearer ${env.OPENAI_API_KEY}`,
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
        summary:
          "Phân tích AI bị lỗi, đang trả bảng tạm từ dữ liệu đã thu thập.",
        assumptions: [truncate(detail, 180)],
        rows: fallback
      };
    }

    const data = await resp.json().catch(() => ({}));
    const rawText = extractOutputText(data);
    const parsed = parseJsonObject(rawText);

    if (!parsed || !Array.isArray(parsed.rows)) {
      return {
        summary:
          "AI trả về không đúng định dạng JSON, đang dùng bảng tạm từ nguồn.",
        assumptions: ["Có thể prompt cần tinh chỉnh thêm để ổn định định dạng."],
        rows: fallback
      };
    }

    return {
      summary: cleanString(parsed.summary) || "Đã tổng hợp từ các nguồn đã thu thập.",
      assumptions: Array.isArray(parsed.assumptions)
        ? parsed.assumptions.map(cleanString).filter(Boolean).slice(0, 8)
        : [],
      rows: parsed.rows
        .map((row) => ({
          name: cleanString(row.name),
          address: cleanString(row.address),
          tuition: cleanString(row.tuition),
          source_url: cleanString(row.source_url),
          notes: cleanString(row.notes)
        }))
        .filter((row) => row.name || row.source_url)
        .slice(0, topK)
    };
  } catch (error) {
    return {
      summary: "Lỗi khi gọi AI, đang dùng bảng tạm từ dữ liệu nguồn.",
      assumptions: [String(error && error.message ? error.message : error)],
      rows: fallback
    };
  }
}

function fallbackRowsFromSources(query, topK, sources) {
  const rows = [];
  for (const src of sources.slice(0, topK)) {
    rows.push({
      name: smartNameFromTitle(src.title, query),
      address: "",
      tuition: "",
      source_url: src.url,
      notes: src.snippet || "Thiếu dữ liệu chi tiết từ nguồn."
    });
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


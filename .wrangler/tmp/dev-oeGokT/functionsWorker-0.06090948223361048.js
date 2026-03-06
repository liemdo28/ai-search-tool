var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// .wrangler/tmp/pages-zsRqFH/functionsWorker-0.06090948223361048.mjs
var __defProp2 = Object.defineProperty;
var __name2 = /* @__PURE__ */ __name((target, value) => __defProp2(target, "name", { value, configurable: true }), "__name");
async function onRequestGet() {
  return new Response(
    JSON.stringify({
      ok: true,
      service: "ai-search-neon-tool",
      now: (/* @__PURE__ */ new Date()).toISOString()
    }),
    {
      headers: {
        "content-type": "application/json; charset=utf-8"
      }
    }
  );
}
__name(onRequestGet, "onRequestGet");
__name2(onRequestGet, "onRequestGet");
var ALLOWED_ENGINES = /* @__PURE__ */ new Set(["google", "bing", "duckduckgo", "yahoo"]);
async function onRequestPost({ request, env }) {
  try {
    const body = await request.json().catch(() => ({}));
    const query = cleanString(body.query);
    const targetSites = clampInt(body.target_sites, 5, 60, 20);
    const topK = clampInt(body.top_k, 1, 20, 5);
    const engines = normalizeEngines(body.engines);
    if (!query || query.length < 3) {
      return json({ ok: false, error: "Query c\u1EA7n t\u1ED1i thi\u1EC3u 3 k\xFD t\u1EF1." }, 400);
    }
    if (!env.SERPAPI_API_KEY) {
      return json(
        { ok: false, error: "Thi\u1EBFu SERPAPI_API_KEY tr\xEAn server." },
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
        summary: "Kh\xF4ng thu th\u1EADp \u0111\u01B0\u1EE3c ngu\u1ED3n ph\xF9 h\u1EE3p t\u1EEB c\xF4ng c\u1EE5 t\xECm ki\u1EBFm.",
        assumptions: ["Th\u1EED \u0111\u1ED5i t\u1EEB kh\xF3a c\u1EE5 th\u1EC3 h\u01A1n ho\u1EB7c t\u0103ng s\u1ED1 website."],
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
        error: "L\u1ED7i server.",
        detail: String(error && error.message ? error.message : error)
      },
      500
    );
  }
}
__name(onRequestPost, "onRequestPost");
__name2(onRequestPost, "onRequestPost");
async function collectSources({
  query,
  engines,
  targetSites,
  lang,
  country,
  serpApiKey
}) {
  const dedup = /* @__PURE__ */ new Map();
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
__name(collectSources, "collectSources");
__name2(collectSources, "collectSources");
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
  const res = await fetchWithTimeout(url.toString(), { method: "GET" }, 25e3);
  if (!res.ok) return [];
  const data = await res.json().catch(() => ({}));
  const organic = Array.isArray(data.organic_results) ? data.organic_results : [];
  return organic.map((item) => ({
    engine,
    title: cleanString(item.title),
    url: cleanString(item.link || item.url),
    snippet: cleanString(item.snippet),
    position: item.position
  })).filter((item) => item.url && item.title);
}
__name(searchSerpApi, "searchSerpApi");
__name2(searchSerpApi, "searchSerpApi");
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
          18e3
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
__name(enrichSourcesWithContent, "enrichSourcesWithContent");
__name2(enrichSourcesWithContent, "enrichSourcesWithContent");
async function synthesizeTable({ query, topK, sources, env }) {
  const fallback = fallbackRowsFromSources(query, topK, sources);
  if (!env.OPENAI_API_KEY) {
    return {
      summary: "\u0110\xE3 thu th\u1EADp ngu\u1ED3n nh\u01B0ng thi\u1EBFu OPENAI_API_KEY n\xEAn ch\u01B0a ph\xE2n t\xEDch t\u1EF1 \u0111\u1ED9ng \u0111\u1EA7y \u0111\u1EE7.",
      assumptions: [
        "B\u1EA3ng t\u1EA1m th\u1EDDi \u0111\u01B0\u1EE3c d\u1EF1ng t\u1EEB title/snippet.",
        "C\u1EA5u h\xECnh OPENAI_API_KEY \u0111\u1EC3 tr\xEDch xu\u1EA5t h\u1ECDc ph\xED v\xE0 \u0111\u1ECBa ch\u1EC9 ch\xEDnh x\xE1c h\u01A1n."
      ],
      rows: fallback
    };
  }
  const evidence = sources.map(
    (s, i) => `[${i + 1}] Engine: ${s.engine}
Title: ${s.title}
URL: ${s.url}
Snippet: ${s.snippet}
Extract: ${s.content_excerpt}`
  ).join("\n\n");
  const prompt = `
B\u1EA1n l\xE0 h\u1EC7 th\u1ED1ng ph\xE2n t\xEDch d\u1EEF li\u1EC7u t\u1EEB nhi\u1EC1u website.
Nhi\u1EC7m v\u1EE5: v\u1EDBi c\xE2u h\u1ECFi c\u1EE7a ng\u01B0\u1EDDi d\xF9ng, t\u1EA1o b\u1EA3ng top ${topK} k\u1EBFt qu\u1EA3 ph\xF9 h\u1EE3p nh\u1EA5t d\u1EF1a tr\xEAn ngu\u1ED3n b\xEAn d\u01B0\u1EDBi.

QUY T\u1EAEC:
1) Ch\u1EC9 d\xF9ng d\u1EEF li\u1EC7u c\xF3 trong ngu\u1ED3n. Kh\xF4ng suy di\u1EC5n khi thi\u1EBFu b\u1EB1ng ch\u1EE9ng.
2) N\u1EBFu kh\xF4ng t\xECm th\u1EA5y \u0111\u1ECBa ch\u1EC9 ho\u1EB7c h\u1ECDc ph\xED, \u0111\u1EC3 chu\u1ED7i r\u1ED7ng "".
3) \u01AFu ti\xEAn c\xE1c m\u1EE5c c\xF3 th\xF4ng tin h\u1ECDc ph\xED r\xF5 r\xE0ng.
4) Tr\u1EA3 \u0111\xFAng JSON object, kh\xF4ng th\xEAm markdown:
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
5) rows t\u1ED1i \u0111a ${topK} ph\u1EA7n t\u1EED.

C\xC2U H\u1ECEI: ${query}

NGU\u1ED2N:
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
      45e3
    );
    if (!resp.ok) {
      const detail = await resp.text();
      return {
        summary: "Ph\xE2n t\xEDch AI b\u1ECB l\u1ED7i, \u0111ang tr\u1EA3 b\u1EA3ng t\u1EA1m t\u1EEB d\u1EEF li\u1EC7u \u0111\xE3 thu th\u1EADp.",
        assumptions: [truncate(detail, 180)],
        rows: fallback
      };
    }
    const data = await resp.json().catch(() => ({}));
    const rawText = extractOutputText(data);
    const parsed = parseJsonObject(rawText);
    if (!parsed || !Array.isArray(parsed.rows)) {
      return {
        summary: "AI tr\u1EA3 v\u1EC1 kh\xF4ng \u0111\xFAng \u0111\u1ECBnh d\u1EA1ng JSON, \u0111ang d\xF9ng b\u1EA3ng t\u1EA1m t\u1EEB ngu\u1ED3n.",
        assumptions: ["C\xF3 th\u1EC3 prompt c\u1EA7n tinh ch\u1EC9nh th\xEAm \u0111\u1EC3 \u1ED5n \u0111\u1ECBnh \u0111\u1ECBnh d\u1EA1ng."],
        rows: fallback
      };
    }
    return {
      summary: cleanString(parsed.summary) || "\u0110\xE3 t\u1ED5ng h\u1EE3p t\u1EEB c\xE1c ngu\u1ED3n \u0111\xE3 thu th\u1EADp.",
      assumptions: Array.isArray(parsed.assumptions) ? parsed.assumptions.map(cleanString).filter(Boolean).slice(0, 8) : [],
      rows: parsed.rows.map((row) => ({
        name: cleanString(row.name),
        address: cleanString(row.address),
        tuition: cleanString(row.tuition),
        source_url: cleanString(row.source_url),
        notes: cleanString(row.notes)
      })).filter((row) => row.name || row.source_url).slice(0, topK)
    };
  } catch (error) {
    return {
      summary: "L\u1ED7i khi g\u1ECDi AI, \u0111ang d\xF9ng b\u1EA3ng t\u1EA1m t\u1EEB d\u1EEF li\u1EC7u ngu\u1ED3n.",
      assumptions: [String(error && error.message ? error.message : error)],
      rows: fallback
    };
  }
}
__name(synthesizeTable, "synthesizeTable");
__name2(synthesizeTable, "synthesizeTable");
function fallbackRowsFromSources(query, topK, sources) {
  const rows = [];
  for (const src of sources.slice(0, topK)) {
    rows.push({
      name: smartNameFromTitle(src.title, query),
      address: "",
      tuition: "",
      source_url: src.url,
      notes: src.snippet || "Thi\u1EBFu d\u1EEF li\u1EC7u chi ti\u1EBFt t\u1EEB ngu\u1ED3n."
    });
  }
  return rows;
}
__name(fallbackRowsFromSources, "fallbackRowsFromSources");
__name2(fallbackRowsFromSources, "fallbackRowsFromSources");
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
  __name(runOne, "runOne");
  __name2(runOne, "runOne");
  const jobs = [];
  for (let i = 0; i < Math.min(concurrency, items.length); i += 1) {
    jobs.push(runOne());
  }
  await Promise.all(jobs);
  return results;
}
__name(runPool, "runPool");
__name2(runPool, "runPool");
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
__name(extractOutputText, "extractOutputText");
__name2(extractOutputText, "extractOutputText");
function parseJsonObject(text) {
  if (!text || typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
  }
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
    }
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
    }
  }
  return null;
}
__name(parseJsonObject, "parseJsonObject");
__name2(parseJsonObject, "parseJsonObject");
function smartNameFromTitle(title, query) {
  const t = cleanString(title);
  if (!t) return cleanString(query);
  const split = t.split(/[|\-–—:]/).map((x) => x.trim()).filter(Boolean);
  return split.length > 0 ? split[0] : t;
}
__name(smartNameFromTitle, "smartNameFromTitle");
__name2(smartNameFromTitle, "smartNameFromTitle");
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
__name(htmlToText, "htmlToText");
__name2(htmlToText, "htmlToText");
function decodeHtml(str) {
  return str.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}
__name(decodeHtml, "decodeHtml");
__name2(decodeHtml, "decodeHtml");
async function fetchWithTimeout(url, init, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort("timeout"), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}
__name(fetchWithTimeout, "fetchWithTimeout");
__name2(fetchWithTimeout, "fetchWithTimeout");
function normalizeEngines(input) {
  const raw = Array.isArray(input) ? input : ["google", "bing"];
  const normalized = raw.map((v) => cleanString(v).toLowerCase()).filter((v) => ALLOWED_ENGINES.has(v));
  return normalized.length > 0 ? normalized : ["google", "bing"];
}
__name(normalizeEngines, "normalizeEngines");
__name2(normalizeEngines, "normalizeEngines");
function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(String(value), 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
__name(clampInt, "clampInt");
__name2(clampInt, "clampInt");
function cleanString(value) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim();
}
__name(cleanString, "cleanString");
__name2(cleanString, "cleanString");
function truncate(text, maxLen) {
  const t = cleanString(String(text || ""));
  if (t.length <= maxLen) return t;
  return `${t.slice(0, maxLen)}...`;
}
__name(truncate, "truncate");
__name2(truncate, "truncate");
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8"
    }
  });
}
__name(json, "json");
__name2(json, "json");
var routes = [
  {
    routePath: "/api/health",
    mountPath: "/api",
    method: "GET",
    middlewares: [],
    modules: [onRequestGet]
  },
  {
    routePath: "/api/run",
    mountPath: "/api",
    method: "POST",
    middlewares: [],
    modules: [onRequestPost]
  }
];
function lexer(str) {
  var tokens = [];
  var i = 0;
  while (i < str.length) {
    var char = str[i];
    if (char === "*" || char === "+" || char === "?") {
      tokens.push({ type: "MODIFIER", index: i, value: str[i++] });
      continue;
    }
    if (char === "\\") {
      tokens.push({ type: "ESCAPED_CHAR", index: i++, value: str[i++] });
      continue;
    }
    if (char === "{") {
      tokens.push({ type: "OPEN", index: i, value: str[i++] });
      continue;
    }
    if (char === "}") {
      tokens.push({ type: "CLOSE", index: i, value: str[i++] });
      continue;
    }
    if (char === ":") {
      var name = "";
      var j = i + 1;
      while (j < str.length) {
        var code = str.charCodeAt(j);
        if (
          // `0-9`
          code >= 48 && code <= 57 || // `A-Z`
          code >= 65 && code <= 90 || // `a-z`
          code >= 97 && code <= 122 || // `_`
          code === 95
        ) {
          name += str[j++];
          continue;
        }
        break;
      }
      if (!name)
        throw new TypeError("Missing parameter name at ".concat(i));
      tokens.push({ type: "NAME", index: i, value: name });
      i = j;
      continue;
    }
    if (char === "(") {
      var count = 1;
      var pattern = "";
      var j = i + 1;
      if (str[j] === "?") {
        throw new TypeError('Pattern cannot start with "?" at '.concat(j));
      }
      while (j < str.length) {
        if (str[j] === "\\") {
          pattern += str[j++] + str[j++];
          continue;
        }
        if (str[j] === ")") {
          count--;
          if (count === 0) {
            j++;
            break;
          }
        } else if (str[j] === "(") {
          count++;
          if (str[j + 1] !== "?") {
            throw new TypeError("Capturing groups are not allowed at ".concat(j));
          }
        }
        pattern += str[j++];
      }
      if (count)
        throw new TypeError("Unbalanced pattern at ".concat(i));
      if (!pattern)
        throw new TypeError("Missing pattern at ".concat(i));
      tokens.push({ type: "PATTERN", index: i, value: pattern });
      i = j;
      continue;
    }
    tokens.push({ type: "CHAR", index: i, value: str[i++] });
  }
  tokens.push({ type: "END", index: i, value: "" });
  return tokens;
}
__name(lexer, "lexer");
__name2(lexer, "lexer");
function parse(str, options) {
  if (options === void 0) {
    options = {};
  }
  var tokens = lexer(str);
  var _a = options.prefixes, prefixes = _a === void 0 ? "./" : _a, _b = options.delimiter, delimiter = _b === void 0 ? "/#?" : _b;
  var result = [];
  var key = 0;
  var i = 0;
  var path = "";
  var tryConsume = /* @__PURE__ */ __name2(function(type) {
    if (i < tokens.length && tokens[i].type === type)
      return tokens[i++].value;
  }, "tryConsume");
  var mustConsume = /* @__PURE__ */ __name2(function(type) {
    var value2 = tryConsume(type);
    if (value2 !== void 0)
      return value2;
    var _a2 = tokens[i], nextType = _a2.type, index = _a2.index;
    throw new TypeError("Unexpected ".concat(nextType, " at ").concat(index, ", expected ").concat(type));
  }, "mustConsume");
  var consumeText = /* @__PURE__ */ __name2(function() {
    var result2 = "";
    var value2;
    while (value2 = tryConsume("CHAR") || tryConsume("ESCAPED_CHAR")) {
      result2 += value2;
    }
    return result2;
  }, "consumeText");
  var isSafe = /* @__PURE__ */ __name2(function(value2) {
    for (var _i = 0, delimiter_1 = delimiter; _i < delimiter_1.length; _i++) {
      var char2 = delimiter_1[_i];
      if (value2.indexOf(char2) > -1)
        return true;
    }
    return false;
  }, "isSafe");
  var safePattern = /* @__PURE__ */ __name2(function(prefix2) {
    var prev = result[result.length - 1];
    var prevText = prefix2 || (prev && typeof prev === "string" ? prev : "");
    if (prev && !prevText) {
      throw new TypeError('Must have text between two parameters, missing text after "'.concat(prev.name, '"'));
    }
    if (!prevText || isSafe(prevText))
      return "[^".concat(escapeString(delimiter), "]+?");
    return "(?:(?!".concat(escapeString(prevText), ")[^").concat(escapeString(delimiter), "])+?");
  }, "safePattern");
  while (i < tokens.length) {
    var char = tryConsume("CHAR");
    var name = tryConsume("NAME");
    var pattern = tryConsume("PATTERN");
    if (name || pattern) {
      var prefix = char || "";
      if (prefixes.indexOf(prefix) === -1) {
        path += prefix;
        prefix = "";
      }
      if (path) {
        result.push(path);
        path = "";
      }
      result.push({
        name: name || key++,
        prefix,
        suffix: "",
        pattern: pattern || safePattern(prefix),
        modifier: tryConsume("MODIFIER") || ""
      });
      continue;
    }
    var value = char || tryConsume("ESCAPED_CHAR");
    if (value) {
      path += value;
      continue;
    }
    if (path) {
      result.push(path);
      path = "";
    }
    var open = tryConsume("OPEN");
    if (open) {
      var prefix = consumeText();
      var name_1 = tryConsume("NAME") || "";
      var pattern_1 = tryConsume("PATTERN") || "";
      var suffix = consumeText();
      mustConsume("CLOSE");
      result.push({
        name: name_1 || (pattern_1 ? key++ : ""),
        pattern: name_1 && !pattern_1 ? safePattern(prefix) : pattern_1,
        prefix,
        suffix,
        modifier: tryConsume("MODIFIER") || ""
      });
      continue;
    }
    mustConsume("END");
  }
  return result;
}
__name(parse, "parse");
__name2(parse, "parse");
function match(str, options) {
  var keys = [];
  var re = pathToRegexp(str, keys, options);
  return regexpToFunction(re, keys, options);
}
__name(match, "match");
__name2(match, "match");
function regexpToFunction(re, keys, options) {
  if (options === void 0) {
    options = {};
  }
  var _a = options.decode, decode = _a === void 0 ? function(x) {
    return x;
  } : _a;
  return function(pathname) {
    var m = re.exec(pathname);
    if (!m)
      return false;
    var path = m[0], index = m.index;
    var params = /* @__PURE__ */ Object.create(null);
    var _loop_1 = /* @__PURE__ */ __name2(function(i2) {
      if (m[i2] === void 0)
        return "continue";
      var key = keys[i2 - 1];
      if (key.modifier === "*" || key.modifier === "+") {
        params[key.name] = m[i2].split(key.prefix + key.suffix).map(function(value) {
          return decode(value, key);
        });
      } else {
        params[key.name] = decode(m[i2], key);
      }
    }, "_loop_1");
    for (var i = 1; i < m.length; i++) {
      _loop_1(i);
    }
    return { path, index, params };
  };
}
__name(regexpToFunction, "regexpToFunction");
__name2(regexpToFunction, "regexpToFunction");
function escapeString(str) {
  return str.replace(/([.+*?=^!:${}()[\]|/\\])/g, "\\$1");
}
__name(escapeString, "escapeString");
__name2(escapeString, "escapeString");
function flags(options) {
  return options && options.sensitive ? "" : "i";
}
__name(flags, "flags");
__name2(flags, "flags");
function regexpToRegexp(path, keys) {
  if (!keys)
    return path;
  var groupsRegex = /\((?:\?<(.*?)>)?(?!\?)/g;
  var index = 0;
  var execResult = groupsRegex.exec(path.source);
  while (execResult) {
    keys.push({
      // Use parenthesized substring match if available, index otherwise
      name: execResult[1] || index++,
      prefix: "",
      suffix: "",
      modifier: "",
      pattern: ""
    });
    execResult = groupsRegex.exec(path.source);
  }
  return path;
}
__name(regexpToRegexp, "regexpToRegexp");
__name2(regexpToRegexp, "regexpToRegexp");
function arrayToRegexp(paths, keys, options) {
  var parts = paths.map(function(path) {
    return pathToRegexp(path, keys, options).source;
  });
  return new RegExp("(?:".concat(parts.join("|"), ")"), flags(options));
}
__name(arrayToRegexp, "arrayToRegexp");
__name2(arrayToRegexp, "arrayToRegexp");
function stringToRegexp(path, keys, options) {
  return tokensToRegexp(parse(path, options), keys, options);
}
__name(stringToRegexp, "stringToRegexp");
__name2(stringToRegexp, "stringToRegexp");
function tokensToRegexp(tokens, keys, options) {
  if (options === void 0) {
    options = {};
  }
  var _a = options.strict, strict = _a === void 0 ? false : _a, _b = options.start, start = _b === void 0 ? true : _b, _c = options.end, end = _c === void 0 ? true : _c, _d = options.encode, encode = _d === void 0 ? function(x) {
    return x;
  } : _d, _e = options.delimiter, delimiter = _e === void 0 ? "/#?" : _e, _f = options.endsWith, endsWith = _f === void 0 ? "" : _f;
  var endsWithRe = "[".concat(escapeString(endsWith), "]|$");
  var delimiterRe = "[".concat(escapeString(delimiter), "]");
  var route = start ? "^" : "";
  for (var _i = 0, tokens_1 = tokens; _i < tokens_1.length; _i++) {
    var token = tokens_1[_i];
    if (typeof token === "string") {
      route += escapeString(encode(token));
    } else {
      var prefix = escapeString(encode(token.prefix));
      var suffix = escapeString(encode(token.suffix));
      if (token.pattern) {
        if (keys)
          keys.push(token);
        if (prefix || suffix) {
          if (token.modifier === "+" || token.modifier === "*") {
            var mod = token.modifier === "*" ? "?" : "";
            route += "(?:".concat(prefix, "((?:").concat(token.pattern, ")(?:").concat(suffix).concat(prefix, "(?:").concat(token.pattern, "))*)").concat(suffix, ")").concat(mod);
          } else {
            route += "(?:".concat(prefix, "(").concat(token.pattern, ")").concat(suffix, ")").concat(token.modifier);
          }
        } else {
          if (token.modifier === "+" || token.modifier === "*") {
            throw new TypeError('Can not repeat "'.concat(token.name, '" without a prefix and suffix'));
          }
          route += "(".concat(token.pattern, ")").concat(token.modifier);
        }
      } else {
        route += "(?:".concat(prefix).concat(suffix, ")").concat(token.modifier);
      }
    }
  }
  if (end) {
    if (!strict)
      route += "".concat(delimiterRe, "?");
    route += !options.endsWith ? "$" : "(?=".concat(endsWithRe, ")");
  } else {
    var endToken = tokens[tokens.length - 1];
    var isEndDelimited = typeof endToken === "string" ? delimiterRe.indexOf(endToken[endToken.length - 1]) > -1 : endToken === void 0;
    if (!strict) {
      route += "(?:".concat(delimiterRe, "(?=").concat(endsWithRe, "))?");
    }
    if (!isEndDelimited) {
      route += "(?=".concat(delimiterRe, "|").concat(endsWithRe, ")");
    }
  }
  return new RegExp(route, flags(options));
}
__name(tokensToRegexp, "tokensToRegexp");
__name2(tokensToRegexp, "tokensToRegexp");
function pathToRegexp(path, keys, options) {
  if (path instanceof RegExp)
    return regexpToRegexp(path, keys);
  if (Array.isArray(path))
    return arrayToRegexp(path, keys, options);
  return stringToRegexp(path, keys, options);
}
__name(pathToRegexp, "pathToRegexp");
__name2(pathToRegexp, "pathToRegexp");
var escapeRegex = /[.+?^${}()|[\]\\]/g;
function* executeRequest(request) {
  const requestPath = new URL(request.url).pathname;
  for (const route of [...routes].reverse()) {
    if (route.method && route.method !== request.method) {
      continue;
    }
    const routeMatcher = match(route.routePath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const mountMatcher = match(route.mountPath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const matchResult = routeMatcher(requestPath);
    const mountMatchResult = mountMatcher(requestPath);
    if (matchResult && mountMatchResult) {
      for (const handler of route.middlewares.flat()) {
        yield {
          handler,
          params: matchResult.params,
          path: mountMatchResult.path
        };
      }
    }
  }
  for (const route of routes) {
    if (route.method && route.method !== request.method) {
      continue;
    }
    const routeMatcher = match(route.routePath.replace(escapeRegex, "\\$&"), {
      end: true
    });
    const mountMatcher = match(route.mountPath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const matchResult = routeMatcher(requestPath);
    const mountMatchResult = mountMatcher(requestPath);
    if (matchResult && mountMatchResult && route.modules.length) {
      for (const handler of route.modules.flat()) {
        yield {
          handler,
          params: matchResult.params,
          path: matchResult.path
        };
      }
      break;
    }
  }
}
__name(executeRequest, "executeRequest");
__name2(executeRequest, "executeRequest");
var pages_template_worker_default = {
  async fetch(originalRequest, env, workerContext) {
    let request = originalRequest;
    const handlerIterator = executeRequest(request);
    let data = {};
    let isFailOpen = false;
    const next = /* @__PURE__ */ __name2(async (input, init) => {
      if (input !== void 0) {
        let url = input;
        if (typeof input === "string") {
          url = new URL(input, request.url).toString();
        }
        request = new Request(url, init);
      }
      const result = handlerIterator.next();
      if (result.done === false) {
        const { handler, params, path } = result.value;
        const context = {
          request: new Request(request.clone()),
          functionPath: path,
          next,
          params,
          get data() {
            return data;
          },
          set data(value) {
            if (typeof value !== "object" || value === null) {
              throw new Error("context.data must be an object");
            }
            data = value;
          },
          env,
          waitUntil: workerContext.waitUntil.bind(workerContext),
          passThroughOnException: /* @__PURE__ */ __name2(() => {
            isFailOpen = true;
          }, "passThroughOnException")
        };
        const response = await handler(context);
        if (!(response instanceof Response)) {
          throw new Error("Your Pages function should return a Response");
        }
        return cloneResponse(response);
      } else if ("ASSETS") {
        const response = await env["ASSETS"].fetch(request);
        return cloneResponse(response);
      } else {
        const response = await fetch(request);
        return cloneResponse(response);
      }
    }, "next");
    try {
      return await next();
    } catch (error) {
      if (isFailOpen) {
        const response = await env["ASSETS"].fetch(request);
        return cloneResponse(response);
      }
      throw error;
    }
  }
};
var cloneResponse = /* @__PURE__ */ __name2((response) => (
  // https://fetch.spec.whatwg.org/#null-body-status
  new Response(
    [101, 204, 205, 304].includes(response.status) ? null : response.body,
    response
  )
), "cloneResponse");
var drainBody = /* @__PURE__ */ __name2(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
__name2(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name2(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = pages_template_worker_default;
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
__name2(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
__name2(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");
__name2(__facade_invoke__, "__facade_invoke__");
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  static {
    __name(this, "___Facade_ScheduledController__");
  }
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  static {
    __name2(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name2(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name2(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
__name2(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name2((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name2((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
__name2(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;

// node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody2 = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default2 = drainBody2;

// node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError2(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError2(e.cause)
  };
}
__name(reduceError2, "reduceError");
var jsonError2 = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError2(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default2 = jsonError2;

// .wrangler/tmp/bundle-no1mIm/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__2 = [
  middleware_ensure_req_body_drained_default2,
  middleware_miniflare3_json_error_default2
];
var middleware_insertion_facade_default2 = middleware_loader_entry_default;

// node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__2 = [];
function __facade_register__2(...args) {
  __facade_middleware__2.push(...args.flat());
}
__name(__facade_register__2, "__facade_register__");
function __facade_invokeChain__2(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__2(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__2, "__facade_invokeChain__");
function __facade_invoke__2(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__2(request, env, ctx, dispatch, [
    ...__facade_middleware__2,
    finalMiddleware
  ]);
}
__name(__facade_invoke__2, "__facade_invoke__");

// .wrangler/tmp/bundle-no1mIm/middleware-loader.entry.ts
var __Facade_ScheduledController__2 = class ___Facade_ScheduledController__2 {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__2)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler2(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__2 === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__2.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__2) {
    __facade_register__2(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__2(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__2(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler2, "wrapExportedHandler");
function wrapWorkerEntrypoint2(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__2 === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__2.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__2) {
    __facade_register__2(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__2(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__2(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint2, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY2;
if (typeof middleware_insertion_facade_default2 === "object") {
  WRAPPED_ENTRY2 = wrapExportedHandler2(middleware_insertion_facade_default2);
} else if (typeof middleware_insertion_facade_default2 === "function") {
  WRAPPED_ENTRY2 = wrapWorkerEntrypoint2(middleware_insertion_facade_default2);
}
var middleware_loader_entry_default2 = WRAPPED_ENTRY2;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__2 as __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default2 as default
};
//# sourceMappingURL=functionsWorker-0.06090948223361048.js.map

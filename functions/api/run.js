export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json().catch(() => ({}));
    const query = (body.query || "").toString().trim();
    if (!query) return json({ ok: false, error: "Missing 'query'." }, 400);

    const num = clampInt(env.SERPAPI_NUM_RESULTS ?? "5", 1, 10);

    // 1) Search via SerpAPI
    const serpUrl = new URL("https://serpapi.com/search.json");
    serpUrl.searchParams.set("engine", env.SERPAPI_ENGINE || "google");
    serpUrl.searchParams.set("q", query);
    serpUrl.searchParams.set("num", String(num));
    serpUrl.searchParams.set("api_key", env.SERPAPI_API_KEY);

    const serpRes = await fetch(serpUrl.toString(), {
      headers: { "accept": "application/json" },
    });

    if (!serpRes.ok) {
      const t = await serpRes.text();
      return json({ ok: false, error: "SerpAPI error", status: serpRes.status, detail: t.slice(0, 400) }, 502);
    }

    const serp = await serpRes.json();
    const organic = Array.isArray(serp?.organic_results) ? serp.organic_results : [];
    const items = organic.slice(0, num).map((r) => ({
      title: r.title || "",
      link: r.link || r.url || "",
      snippet: r.snippet || "",
      source: r.source || "",
    })).filter(x => x.link);

    if (items.length === 0) {
      return json({ ok: true, query, answer: "Mình không tìm thấy kết quả phù hợp.", sources: [] });
    }

    // 2) Summarize with OpenAI (Responses API)
    const model = env.OPENAI_MODEL || "gpt-4.1-mini";

    const sourcesText = items.map((it, i) =>
      `[${i + 1}] ${it.title}\n${it.snippet}\n${it.link}`
    ).join("\n\n");

    const prompt = `
Bạn là AI Search. Trả lời ngắn gọn, rõ ràng bằng tiếng Việt.
- Dựa trên các nguồn bên dưới (title/snippet/link).
- Nếu thông tin có thể thay đổi theo thời gian, hãy nói rõ "cần kiểm tra lại".
- Cuối câu trả lời, liệt kê citation dạng [1][2]... tương ứng nguồn.

Câu hỏi: ${query}

Nguồn:
${sourcesText}
`.trim();

    const oaRes = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        input: prompt,
      }),
    });

    if (!oaRes.ok) {
      const t = await oaRes.text();
      return json({ ok: false, error: "OpenAI error", status: oaRes.status, detail: t.slice(0, 400) }, 502);
    }

    const oa = await oaRes.json();
    const answer = extractText(oa) || "Mình chưa tạo được câu trả lời.";

    return json({
      ok: true,
      query,
      answer,
      sources: items.map((x) => x.link),
      meta: {
        model,
        results: items,
      },
    });

  } catch (err) {
    return json({ ok: false, error: String(err?.message || err), stack: String(err?.stack || "") }, 500);
  }
}

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
  // Responses API: often has output_text
  if (typeof resp?.output_text === "string") return resp.output_text;
  // fallback: try to find text parts
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
export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json().catch(() => ({}));
    const query = (body.query || "").toString().trim();

    if (!query) {
      return json({ ok: false, error: "Missing 'query' in request body" }, 400);
    }

    // Debug: show env presence only (no secrets)
    return json({
      ok: true,
      query,
      env: {
        OPENAI_API_KEY: env.OPENAI_API_KEY ? "SET" : "MISSING",
        SERPAPI_API_KEY: env.SERPAPI_API_KEY ? "SET" : "MISSING",
      },
      answer: "API /api/run OK (stub). Next step: wire SerpAPI + OpenAI.",
      sources: [],
    });
  } catch (err) {
    return json(
      { ok: false, error: String(err?.message || err), stack: String(err?.stack || "") },
      500
    );
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
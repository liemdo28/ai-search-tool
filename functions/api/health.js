export async function onRequestGet() {
  return new Response(
    JSON.stringify({
      ok: true,
      service: "ai-search-neon-tool",
      now: new Date().toISOString()
    }),
    {
      headers: {
        "content-type": "application/json; charset=utf-8"
      }
    }
  );
}


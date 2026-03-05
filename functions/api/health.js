export async function onRequestGet() {
  return new Response(JSON.stringify({
    ok: true,
    service: "ai-search-tool"
  }), {
    headers: { "content-type": "application/json" }
  })
}
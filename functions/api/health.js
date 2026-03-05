export async function onRequestGet() {
  return new Response(
    JSON.stringify({
      status: "ok",
      service: "ai-search-tool"
    }),
    {
      headers: { "content-type": "application/json" }
    }
  )
}
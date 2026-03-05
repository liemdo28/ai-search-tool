export async function onRequestPost() {
  return new Response(
    JSON.stringify({ ok: true, answer: "run ok", sources: [] }),
    { headers: { "content-type": "application/json; charset=utf-8" } }
  );
}
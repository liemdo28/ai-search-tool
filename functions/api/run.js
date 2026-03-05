export async function onRequestPost(context) {

  const { request, env } = context
  const body = await request.json()

  return new Response(
    JSON.stringify({
      query: body.query,
      result: "API working"
    }),
    {
      headers: { "content-type": "application/json" }
    }
  )
}
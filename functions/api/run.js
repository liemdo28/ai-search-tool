export async function onRequestPost(context) {

  const { request } = context
  const body = await request.json()
  const query = body.query

  // call SerpAPI
  const serp = await fetch(
    `https://serpapi.com/search.json?q=${encodeURIComponent(query)}&api_key=${SERPAPI_API_KEY}`
  )

  const serpData = await serp.json()

  const results = serpData.organic_results.slice(0,3)

  const urls = results.map(r => r.link)

  const content = urls.join("\n")

  // call OpenAI
  const ai = await fetch("https://api.openai.com/v1/chat/completions",{
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      "Authorization":`Bearer ${OPENAI_API_KEY}`
    },
    body:JSON.stringify({
      model:"gpt-4o-mini",
      messages:[
        {role:"system",content:"Answer the question using the sources."},
        {role:"user",content:`Question: ${query}\nSources:\n${content}`}
      ]
    })
  })

  const aiData = await ai.json()

  return new Response(JSON.stringify({
    answer: aiData.choices[0].message.content,
    sources: urls
  }),{
    headers:{ "content-type":"application/json" }
  })
}
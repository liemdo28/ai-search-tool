import os
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import httpx

app = FastAPI()

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4.1-mini")

class SummarizeRequest(BaseModel):
    query: str
    sources_text: str  # preformatted sources: [1] title/snippet/link...

@app.get("/health")
async def health():
    return {"ok": True, "service": "summarizer-proxy"}

@app.post("/summarize")
async def summarize(req: SummarizeRequest):
    if not OPENAI_API_KEY:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY missing on server")

    query = (req.query or "").strip()
    sources_text = (req.sources_text or "").strip()

    if not query:
        raise HTTPException(status_code=400, detail="Missing query")
    if not sources_text:
        raise HTTPException(status_code=400, detail="Missing sources_text")

    prompt = f"""
Bạn là AI Search. Trả lời bằng tiếng Việt, rõ ràng, có cấu trúc.
- Dựa trên các nguồn (title/snippet/link) bên dưới.
- Nếu thông tin có thể thay đổi theo thời gian, nói rõ "cần kiểm tra lại".
- Cuối câu trả lời, thêm citation dạng [1][2]... theo nguồn.

Câu hỏi: {query}

Nguồn:
{sources_text}
""".strip()

    payload = {
        "model": OPENAI_MODEL,
        "input": prompt,
    }

    try:
        async with httpx.AsyncClient(timeout=60) as client:
            r = await client.post(
                "https://api.openai.com/v1/responses",
                headers={
                    "Authorization": f"Bearer {OPENAI_API_KEY}",
                    "Content-Type": "application/json",
                },
                json=payload,
            )
            if r.status_code >= 400:
                # return limited error text (avoid leaking too much)
                raise HTTPException(status_code=502, detail=f"OpenAI error {r.status_code}: {r.text[:400]}")

            data = r.json()
            answer = data.get("output_text") or ""
            if not answer:
                # fallback: try to collect output_text parts
                out = data.get("output", [])
                buf = []
                for item in out:
                    for c in (item.get("content") or []):
                        if c.get("type") == "output_text" and isinstance(c.get("text"), str):
                            buf.append(c["text"])
                answer = "\n".join(buf).strip()

            if not answer:
                answer = "Mình chưa tạo được câu trả lời."

            return {"ok": True, "answer": answer}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Server error: {str(e)}")
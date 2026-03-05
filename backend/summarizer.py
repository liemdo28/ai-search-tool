import os
from typing import List, Dict, Any
from openai import OpenAI # type: ignore

def _fallback_summary(docs: List[Dict[str, Any]], query: str) -> str:
    chunks = []
    for d in docs[:20]:
        title = d.get("title", "")
        url = d.get("url", "")
        snippet = d.get("snippet", "")
        text = d.get("text", "")
        lead = "\n".join(text.splitlines()[:5]) if text else ""
        chunks.append(f"- {title}\n  {snippet}\n  {lead}\n  ({url})")
    return (
        f"Không có LLM key nên tool đang trả về tổng hợp thô theo nguồn.\n\n"
        f"Query: {query}\n\nNguồn tiêu biểu:\n" + "\n\n".join(chunks)
    )

def _build_evidence(docs: List[Dict[str, Any]], max_docs: int = 25) -> str:
    ev = []
    for i, d in enumerate(docs[:max_docs], 1):
        ev.append(
            f"[{i}] {d.get('title','')}\n"
            f"URL: {d.get('url','')}\n"
            f"Snippet: {d.get('snippet','')}\n"
            f"Extract:\n{(d.get('text','') or '')[:1400]}\n"
        )
    return "\n".join(ev)

async def synthesize_answer_vi(
    docs: List[Dict[str, Any]],
    query: str,
    top_k: int,
) -> Dict[str, Any]:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        return {"answer": _fallback_summary(docs, query), "top_items": []}

    client = OpenAI(api_key=api_key)

    evidence = _build_evidence(docs, max_docs=25)

    prompt = f"""
Bạn là công cụ tổng hợp thông tin tiếng Việt.
Trả lời dựa trên bằng chứng (evidence) bên dưới.

Yêu cầu:
- Nếu câu hỏi dạng “top N”, trả ra danh sách TOP {top_k} (ngắn gọn, dễ đọc).
- Mỗi ý phải có trích dẫn nguồn dạng [số] tương ứng evidence.
- Không bịa. Nếu thiếu dữ liệu, nói rõ “chưa đủ bằng chứng”.

CÂU HỎI: {query}

EVIDENCE:
{evidence}
""".strip()

    # Dùng Responses API (khuyến nghị trong docs). :contentReference[oaicite:1]{index=1}
    resp = client.responses.create(
        model=os.getenv("OPENAI_MODEL", "gpt-4.1-mini"),
        input=prompt,
    )

    # Lấy text output
    out_text = ""
    for item in resp.output:
        if item.type == "message":
            for c in item.content:
                if c.type == "output_text":
                    out_text += c.text

    return {"answer": out_text.strip(), "top_items": []}
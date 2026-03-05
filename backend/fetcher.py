import httpx
from typing import Optional, Dict, Any
from readability import Document
from bs4 import BeautifulSoup

def _clean_text(html: str) -> str:
    doc = Document(html)
    content_html = doc.summary(html_partial=True)
    soup = BeautifulSoup(content_html, "lxml")
    text = soup.get_text("\n", strip=True)
    # shrink excessive lines
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    return "\n".join(lines)

async def fetch_article(url: str) -> Dict[str, Any]:
    headers = {
        "User-Agent": "Mozilla/5.0 (AI-Search-Tool; +internal)",
        "Accept": "text/html,application/xhtml+xml",
    }
    try:
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            r = await client.get(url, headers=headers)
            r.raise_for_status()
            html = r.text
        text = _clean_text(html)
        return {"ok": True, "url": url, "text": text[:8000]}  # cap
    except Exception as e:
        return {"ok": False, "url": url, "error": str(e), "text": ""}
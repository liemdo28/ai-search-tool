import os
import math
import httpx
from typing import List, Dict, Any, Optional

SERPAPI_ENDPOINT = "https://serpapi.com/search.json"

class SerpApiClient:
    def __init__(self, api_key: Optional[str] = None):
        self.api_key = api_key or os.getenv("SERPAPI_API_KEY")
        if not self.api_key:
            raise RuntimeError("Missing SERPAPI_API_KEY")

    async def _search_once(self, params: Dict[str, Any]) -> Dict[str, Any]:
        async with httpx.AsyncClient(timeout=40) as client:
            r = await client.get(SERPAPI_ENDPOINT, params=params)
            r.raise_for_status()
            return r.json()

    async def search_urls(
        self,
        query: str,
        n: int = 20,
        language: str = "vi",
        country: str = "vn",
        engine: str = "google_light",
    ) -> List[Dict[str, Any]]:
        """
        Returns list of organic results (title, link, snippet, source_position).
        Notes:
        - Google Search API often returns up to ~10 results per page due to Google limiting num. :contentReference[oaicite:2]{index=2}
        - engine=google_light is a SerpAPI engine optimized for organic results. :contentReference[oaicite:3]{index=3}
        """
        # Heuristic:
        # - google_light: try 100/page, fallback if API still returns only 10.
        # - google: assume 10/page.
        requested_per_page = 100 if engine == "google_light" else 10

        results: List[Dict[str, Any]] = []
        start = 0
        safety_pages = 30  # avoid infinite loops

        while len(results) < n and safety_pages > 0:
            safety_pages -= 1
            params = {
                "engine": engine,
                "q": query,
                "api_key": self.api_key,
                "hl": language,
                "gl": country,
                "start": start,  # pagination offset
            }

            # some engines may accept num; google may ignore it
            params["num"] = requested_per_page

            data = await self._search_once(params)
            organic = data.get("organic_results") or []
            if not organic:
                break

            for item in organic:
                link = item.get("link")
                if not link:
                    continue
                results.append({
                    "title": item.get("title", ""),
                    "link": link,
                    "snippet": item.get("snippet", ""),
                    "position": item.get("position"),
                })
                if len(results) >= n:
                    break

            # If engine returns only 10 consistently, paginate by 10
            page_size = max(1, len(organic))
            start += page_size

        # Deduplicate by link
        seen = set()
        deduped = []
        for r in results:
            if r["link"] in seen:
                continue
            seen.add(r["link"])
            deduped.append(r)
        return deduped[:n]
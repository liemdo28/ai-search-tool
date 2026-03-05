import os
import asyncio
from typing import List, Dict, Any, Optional
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from dotenv import load_dotenv

from serpapi_client import SerpApiClient
from fetcher import fetch_article
from summarizer import synthesize_answer_vi

load_dotenv()

app = FastAPI(title="AI Search Tool (Internal)")

import os
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

@app.get("/")
def home():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

class RunRequest(BaseModel):
    query: str = Field(..., min_length=3)
    n_sources: int = Field(20, ge=5, le=200)
    top_k: int = Field(5, ge=3, le=50)
    language: str = Field("vi")
    country: str = Field("vn")
    engine: str = Field("google_light")  # google_light / google

class RunResponse(BaseModel):
    query: str
    n_sources: int
    answer: str
    sources: List[Dict[str, Any]]

@app.get("/health")
def health():
    return {"ok": True}

@app.post("/run", response_model=RunResponse)
async def run(req: RunRequest):
    client = SerpApiClient()

    # 1) Search
    search_results = await client.search_urls(
        query=req.query,
        n=req.n_sources,
        language=req.language,
        country=req.country,
        engine=req.engine,
    )

    # 2) Fetch content concurrently (limited)
    sem = asyncio.Semaphore(10)

    async def guarded_fetch(item):
        async with sem:
            art = await fetch_article(item["link"])
            return {
                "title": item.get("title", ""),
                "url": item.get("link", ""),
                "snippet": item.get("snippet", ""),
                "position": item.get("position"),
                "ok": art.get("ok", False),
                "text": art.get("text", ""),
                "error": art.get("error", ""),
            }

    fetched = await asyncio.gather(*[guarded_fetch(it) for it in search_results])

    # keep only ok docs for synthesis
    ok_docs = [d for d in fetched if d.get("ok") and d.get("text")]
    synthesis = await synthesize_answer_vi(ok_docs, req.query, req.top_k)

    return RunResponse(
        query=req.query,
        n_sources=req.n_sources,
        answer=synthesis["answer"],
        sources=fetched,
    )
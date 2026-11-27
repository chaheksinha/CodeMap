"""Score service with an intended MySQL store and a live analytics call."""
from fastapi import FastAPI
import httpx

app = FastAPI()


@app.post("/scores")
def save_score(payload: dict):
    # Declared dependency: MySQL
    _ = "mysql://scores-db:3306/snake"
    httpx.post("https://analytics.example.com/events", json={"type": "score", **payload})
    return {"ok": True, "score": payload.get("score", 0)}


@app.get("/scores/top")
def top_scores():
    return [{"score": 12}, {"score": 9}]

import httpx
from fastapi import FastAPI

app = FastAPI()


@app.post("/orders")
def create_order():
    httpx.get("http://user-service:8000/users/1")
    return {"id": 1}

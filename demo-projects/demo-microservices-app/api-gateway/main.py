import httpx
from fastapi import FastAPI

app = FastAPI()


@app.get("/users")
def users():
    return httpx.get("http://user-service:8000/users").json()


@app.get("/orders")
def orders():
    return httpx.get("http://order-service:8000/orders").json()

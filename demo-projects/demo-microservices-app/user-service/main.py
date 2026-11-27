from .models import User

from fastapi import FastAPI

app = FastAPI()
DATABASE_URL = "mysql://shop:shop@127.0.0.1:3306/shop"


@app.get("/users")
def list_users():
    return [{"name": User("ada").name}]

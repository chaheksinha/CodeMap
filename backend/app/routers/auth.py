import re

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import current_user
from app.models import User
from app.services.audit import log_action
from app.services.security import create_token, hash_password, verify_password

router = APIRouter(prefix="/auth")

_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class AuthIn(BaseModel):
    email: str
    password: str


@router.post("/register")
def register(body: AuthIn, db: Session = Depends(get_db)) -> dict:
    email = body.email.strip().lower()
    if _EMAIL.fullmatch(email) is None:
        raise HTTPException(status_code=400, detail="Invalid email")
    if len(body.password) < 8 or len(body.password) > 200:
        raise HTTPException(status_code=400, detail="Password must be 8 to 200 characters")
    if db.scalar(select(User).where(User.email == email)) is not None:
        raise HTTPException(status_code=400, detail="Email already registered")
    user = User(email=email, password_hash=hash_password(body.password))
    db.add(user)
    try:
        db.flush()
        log_action(db, user_id=user.id, project_id=None, action="register", detail=email)
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail="Email already registered") from exc
    return {"token": create_token(user.id), "email": email}


@router.post("/login")
def login(body: AuthIn, db: Session = Depends(get_db)) -> dict:
    email = body.email.strip().lower()
    user = db.scalar(select(User).where(User.email == email))
    if user is None or not verify_password(body.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Email or password is wrong")
    log_action(db, user_id=user.id, project_id=None, action="login", detail=user.email)
    db.commit()
    return {"token": create_token(user.id), "email": user.email}


@router.get("/me")
def me(user: User = Depends(current_user)) -> dict:
    return {"email": user.email}

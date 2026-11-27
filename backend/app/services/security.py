import hashlib
import hmac
import os
from datetime import datetime, timedelta, timezone

import jwt
from jwt import InvalidTokenError

from app.config import settings

ROUNDS = 120_000


def hash_password(password: str) -> str:
    salt = os.urandom(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, ROUNDS)
    return f"{salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        salt_hex, digest_hex = stored.split("$", 1)
        salt = bytes.fromhex(salt_hex)
        check = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, ROUNDS).hex()
        return hmac.compare_digest(check, digest_hex)
    except (ValueError, TypeError):
        return False


def create_token(user_id: int) -> str:
    payload = {
        "sub": str(user_id),
        "exp": datetime.now(timezone.utc) + timedelta(days=7),
    }
    token = jwt.encode(payload, settings.jwt_secret, algorithm="HS256")
    if isinstance(token, bytes):
        return token.decode("ascii")
    return token


def user_id_from_token(token: str) -> int:
    payload = jwt.decode(
        token,
        settings.jwt_secret,
        algorithms=["HS256"],
        options={"require": ["exp", "sub"]},
    )
    subject = payload.get("sub")
    if not isinstance(subject, str) or not subject.isdigit():
        raise InvalidTokenError("subject must be a user id")
    return int(subject)

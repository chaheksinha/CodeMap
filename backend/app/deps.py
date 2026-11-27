from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jwt import InvalidTokenError
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Project, User
from app.services.security import user_id_from_token

bearer = HTTPBearer(auto_error=False)


def current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer),
    db: Session = Depends(get_db),
) -> User:
    if credentials is None or not credentials.credentials:
        raise HTTPException(status_code=401, detail="Sign in again")
    try:
        user_id = user_id_from_token(credentials.credentials)
    except InvalidTokenError as exc:
        raise HTTPException(status_code=401, detail="Sign in again") from exc
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=401, detail="Sign in again")
    return user


def project_or_404(db: Session, user: User, project_id: int) -> Project:
    project = db.get(Project, project_id)
    owner = getattr(project, "user_id", None) if project is not None else None
    if project is None or owner != user.id:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


get_current_user = current_user
owned_project = project_or_404

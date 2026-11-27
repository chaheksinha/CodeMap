from sqlalchemy.orm import Session

from app.models import AuditLog


def log_action(db: Session, *, user_id: int | None, project_id: int | None, action: str, detail: str) -> None:
    db.add(AuditLog(user_id=user_id, project_id=project_id, action=action, detail=detail))

"""Status dataclasses shared by the terrarium worker."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Dict, Literal, Optional

StatusLevel = Literal["online", "degraded", "offline", "unknown"]


def _isoformat(value: Optional[datetime]) -> Optional[str]:
    return value.isoformat() if value else None


@dataclass
class ComponentStatus:
    status: StatusLevel = "unknown"
    detail: Optional[str] = None
    checked_at: Optional[datetime] = None
    latency_ms: Optional[float] = None

    def mark(
        self,
        status: StatusLevel,
        *,
        detail: Optional[str] = None,
        latency_ms: Optional[float] = None,
    ) -> None:
        self.status = status
        self.detail = detail
        self.latency_ms = latency_ms
        self.checked_at = datetime.utcnow()

    def to_payload(self) -> Dict[str, Any]:
        return {
            "status": self.status,
            "detail": self.detail,
            "checkedAt": _isoformat(self.checked_at),
            "latencyMs": self.latency_ms,
        }


@dataclass
class WorkerStatusReport:
    agent_api: ComponentStatus
    llm: ComponentStatus

    def to_payload(self) -> Dict[str, Any]:
        return {
            "agentApi": self.agent_api.to_payload(),
            "llm": self.llm.to_payload(),
        }

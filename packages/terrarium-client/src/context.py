"""Conversation context helpers inspired by terrarium-irc."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import List


@dataclass
class ConversationTurn:
    role: str
    content: str
    created_at: datetime = field(default_factory=datetime.utcnow)


@dataclass
class Conversation:
    chat_id: str
    turns: List[ConversationTurn] = field(default_factory=list)
    last_activity: datetime = field(default_factory=datetime.utcnow)

    def add(self, role: str, content: str) -> None:
        self.turns.append(ConversationTurn(role=role, content=content))
        self.last_activity = datetime.utcnow()

    def prune(self, max_turns: int = 10) -> None:
        if len(self.turns) > max_turns:
            self.turns = self.turns[-max_turns:]

    def is_stale(self, hours: int = 2) -> bool:
        return datetime.utcnow() - self.last_activity > timedelta(hours=hours)

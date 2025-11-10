"""Conversation context helpers inspired by terrarium-irc."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import List, Optional, Sequence


@dataclass
class ConversationTurn:
    message_id: Optional[str]
    role: str
    content: str
    created_at: datetime = field(default_factory=datetime.utcnow)


@dataclass
class Conversation:
    chat_id: str
    turns: List[ConversationTurn] = field(default_factory=list)
    last_activity: datetime = field(default_factory=datetime.utcnow)
    _seen_message_ids: set[str] = field(default_factory=set)

    def add_turn(self, role: str, content: str, *, message_id: Optional[str] = None) -> None:
        if message_id:
            self._seen_message_ids.add(message_id)
        self.turns.append(ConversationTurn(message_id=message_id, role=role, content=content))
        self.last_activity = datetime.utcnow()

    def ingest(self, *, role: str, content: str, message_id: str) -> bool:
        if message_id in self._seen_message_ids:
            return False
        self.add_turn(role, content, message_id=message_id)
        return True

    def prune(self, max_turns: int = 10) -> None:
        if len(self.turns) > max_turns:
            self.turns = self.turns[-max_turns:]

    def is_stale(self, hours: int = 2) -> bool:
        return datetime.utcnow() - self.last_activity > timedelta(hours=hours)

    def to_prompt_messages(self, system_prompt: str, max_turns: int = 12) -> List[dict]:
        self.prune(max_turns=max_turns)
        history: Sequence[ConversationTurn] = self.turns[-max_turns:]
        messages: List[dict] = [{"role": "system", "content": system_prompt}]
        for turn in history:
            messages.append({"role": turn.role, "content": turn.content})
        return messages

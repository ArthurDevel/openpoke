from __future__ import annotations

import asyncio
import threading
import time
from typing import Any, Dict, Set


ConversationEvent = Dict[str, Any]


class ConversationEventHub:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._subscribers: Set[asyncio.Queue[ConversationEvent]] = set()

    def subscribe(self) -> asyncio.Queue[ConversationEvent]:
        queue: asyncio.Queue[ConversationEvent] = asyncio.Queue(maxsize=128)
        with self._lock:
            self._subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue[ConversationEvent]) -> None:
        with self._lock:
            self._subscribers.discard(queue)

    def publish(self, event_type: str, **payload: Any) -> None:
        event: ConversationEvent = {
            "type": event_type,
            "created_at": time.time(),
            **payload,
        }
        with self._lock:
            subscribers = tuple(self._subscribers)

        for queue in subscribers:
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
                try:
                    queue.put_nowait(event)
                except asyncio.QueueFull:
                    continue


_conversation_event_hub = ConversationEventHub()


def get_conversation_event_hub() -> ConversationEventHub:
    return _conversation_event_hub


__all__ = ["ConversationEventHub", "ConversationEvent", "get_conversation_event_hub"]

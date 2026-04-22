import asyncio
import time
from typing import Optional, Union

from fastapi import status
from fastapi.responses import JSONResponse, PlainTextResponse

from ...agents.interaction_agent.runtime import InteractionAgentRuntime
from ...logging_config import logger
from ...models import ChatMessage, ChatRequest
from ...utils import error_response


# Extract the most recent user message from the chat request payload
def _extract_latest_user_message(payload: ChatRequest) -> Optional[ChatMessage]:
    for message in reversed(payload.messages):
        if message.role.lower().strip() == "user" and message.content.strip():
            return message
    return None


# Process incoming chat requests by routing them to the interaction agent runtime
async def handle_chat_request(payload: ChatRequest) -> Union[PlainTextResponse, JSONResponse]:
    """Handle a chat request using the InteractionAgentRuntime."""

    t0 = time.perf_counter()
    request_id = payload.request_id or "-"

    # Extract user message
    user_message = _extract_latest_user_message(payload)
    if user_message is None:
        return error_response("Missing user message", status_code=status.HTTP_400_BAD_REQUEST)

    user_content = user_message.content.strip()  # Already checked in _extract_latest_user_message

    logger.info(
        "trace stage=chat_received request_id=%s dt_ms=0 msg_len=%d",
        request_id,
        len(user_content),
    )

    try:
        runtime = InteractionAgentRuntime()
    except ValueError as ve:
        # Missing API key error
        logger.error("configuration error", extra={"error": str(ve)})
        return error_response(str(ve), status_code=status.HTTP_400_BAD_REQUEST)

    async def _run_interaction() -> None:
        try:
            await runtime.execute(user_message=user_content, request_id=payload.request_id)
        except Exception as exc:  # pragma: no cover - defensive
            logger.exception("chat task failed: %s", exc)

    asyncio.create_task(_run_interaction())

    logger.info(
        "trace stage=chat_accepted request_id=%s dt_ms=%d",
        request_id,
        int((time.perf_counter() - t0) * 1000),
    )
    return PlainTextResponse("", status_code=status.HTTP_202_ACCEPTED)

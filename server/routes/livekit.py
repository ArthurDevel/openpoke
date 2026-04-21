from __future__ import annotations

from uuid import uuid4

from fastapi import APIRouter, HTTPException, status

from ..config import get_settings
from ..models import LiveKitTokenRequest, LiveKitTokenResponse

router = APIRouter(prefix="/livekit", tags=["livekit"])


@router.post("/token", response_model=LiveKitTokenResponse, status_code=status.HTTP_201_CREATED)
def create_livekit_token(payload: LiveKitTokenRequest) -> LiveKitTokenResponse:
    settings = get_settings()

    if not settings.livekit_url or not settings.livekit_api_key or not settings.livekit_api_secret:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="LiveKit is not configured. Set LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET.",
        )

    try:
        from livekit import api as livekit_api
    except ImportError as exc:  # pragma: no cover - environment-specific
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="LiveKit backend support is not installed.",
        ) from exc

    room_name = (payload.room_name or f"{settings.livekit_room_prefix}-talk").strip()
    if not room_name:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="room_name cannot be empty")

    participant_identity = (payload.participant_identity or f"web-{uuid4().hex[:12]}").strip()
    participant_name = (payload.participant_name or "OpenPoke user").strip() or "OpenPoke user"

    token = (
        livekit_api.AccessToken(settings.livekit_api_key, settings.livekit_api_secret)
        .with_identity(participant_identity)
        .with_name(participant_name)
        .with_grants(
            livekit_api.VideoGrants(
                room_join=True,
                room=room_name,
                can_publish=True,
                can_subscribe=True,
            )
        )
        .with_room_config(
            livekit_api.RoomConfiguration(
                agents=[livekit_api.RoomAgentDispatch(agent_name=settings.livekit_agent_name)]
            )
        )
        .to_jwt()
    )

    return LiveKitTokenResponse(
        server_url=settings.livekit_url,
        participant_token=token,
        room_name=room_name,
        participant_identity=participant_identity,
    )


__all__ = ["router"]

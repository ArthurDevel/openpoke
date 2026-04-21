from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, ConfigDict, Field


class LiveKitTokenRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    room_name: Optional[str] = Field(default=None)
    participant_identity: Optional[str] = Field(default=None)
    participant_name: Optional[str] = Field(default=None)


class LiveKitTokenResponse(BaseModel):
    server_url: str
    participant_token: str
    room_name: str
    participant_identity: str

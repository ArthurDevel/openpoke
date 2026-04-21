#!/usr/bin/env python3
"""Minimal standalone check for Composio auth and Gmail connected accounts."""

from __future__ import annotations

import os
from pathlib import Path


def load_env(path: Path) -> None:
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        key = key.strip()
        value = value.strip().strip("'\"")
        if key and key not in os.environ:
            os.environ[key] = value


def redact(value: str) -> str:
    if not value:
        return "<missing>"
    if len(value) <= 8:
        return "*" * len(value)
    return f"{value[:8]}...{value[-4:]}"


def main() -> int:
    load_env(Path(__file__).with_name(".env"))

    api_key = os.getenv("COMPOSIO_API_KEY", "")
    auth_config_id = os.getenv("COMPOSIO_GMAIL_AUTH_CONFIG_ID", "")

    print(f"COMPOSIO_API_KEY={redact(api_key)}")
    print(f"COMPOSIO_GMAIL_AUTH_CONFIG_ID={redact(auth_config_id)}")

    try:
        from composio import Composio  # type: ignore
    except Exception as exc:
        print(f"failed to import composio sdk: {exc}")
        return 1

    try:
        client = Composio(api_key=api_key) if api_key else Composio()
        items = client.connected_accounts.list(toolkit_slugs=["GMAIL"])
        data = getattr(items, "data", None)
        if data is None and isinstance(items, dict):
            data = items.get("data")
        print(f"gmail_connected_accounts={len(data or [])}")
        return 0
    except Exception as exc:
        print(f"composio request failed: {exc}")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

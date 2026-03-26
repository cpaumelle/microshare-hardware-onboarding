#!/usr/bin/env python3
"""
Microshare authentication helper.

Gets a PLAY_SESSION token for use with the Microshare API.
Set MICROSHARE_USER and MICROSHARE_PASS as environment variables,
or pass them as arguments.

Usage:
    # Get token (prints to stdout)
    python ms-auth.py

    # Use in scripts
    TOKEN=$(python ms-auth.py)
    curl -H "Authorization: Bearer $TOKEN" https://dapi.microshare.io/robo/*

    # Specify environment
    MICROSHARE_ENV=prod python ms-auth.py
"""

import base64
import json
import os
import sys

import requests

ENV = os.getenv("MICROSHARE_ENV", "dev")
USER = os.getenv("MICROSHARE_USER", "")
PASS = os.getenv("MICROSHARE_PASS", "")

HOSTS = {
    "dev":  "https://dapp.microshare.io",
    "prod": "https://app.microshare.io",
}


def get_token(user: str, password: str, env: str = "dev") -> str:
    host = HOSTS.get(env, HOSTS["dev"])
    resp = requests.post(
        f"{host}/login",
        data={"csrfToken": "api-client", "username": user, "password": password},
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        allow_redirects=False,
        timeout=30,
    )
    cookie = resp.cookies.get("PLAY_SESSION")
    if not cookie:
        raise RuntimeError(f"Login failed (status {resp.status_code})")

    parts = cookie.split(".")
    payload = json.loads(
        base64.urlsafe_b64decode(parts[1] + "=" * (4 - len(parts[1]) % 4))
    )
    return payload["data"]["access_token"]


if __name__ == "__main__":
    if not USER or not PASS:
        print("Set MICROSHARE_USER and MICROSHARE_PASS environment variables", file=sys.stderr)
        sys.exit(1)

    token = get_token(USER, PASS, ENV)
    print(token)

#!/usr/bin/env python3
"""
Microshare authentication helper.

Gets a user session token (from the PLAY_SESSION login cookie) for general API
access — listing robots, reading the data lake, calling /device and /view.

NOT for a robot's `data.auth`. A robot token must be minted with `grant_type=robot`
and scope SHARE:READ,QUERY,WRITE (5 scopes for a bundler), and must return 200 on
/api/share. A session / ALL:ALL token 401s on /api/share, so the robot dispatches
but writes nothing ("silent dispatch death"). See reference/composer-api.md#robots.

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
# Pest-vanity tenants log in at pest.microshare.io — override with
# MICROSHARE_APP=https://pest.microshare.io (app.microshare.io is generic accounts only).


def get_token(user: str, password: str, env: str = "dev") -> str:
    host = os.getenv("MICROSHARE_APP") or HOSTS.get(env, HOSTS["dev"])
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

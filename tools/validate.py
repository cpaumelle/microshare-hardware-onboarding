#!/usr/bin/env python3
"""
Validate your Microshare setup.

Checks authentication, API access, Robot deployment, and device cluster twinning.
Run after following the setup guide to confirm everything works.

Usage:
    export MICROSHARE_USER=you@example.com
    export MICROSHARE_PASS=yourpassword
    python tools/validate.py

    # Also check a specific Robot and its device cluster twinning
    python tools/validate.py --rectype com.taqt.ubiqod.packed
"""

import argparse
import json
import os
import sys

try:
    import requests
except ImportError:
    print("FAIL  'requests' not installed — run: pip install requests")
    sys.exit(1)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ms_auth import get_token, HOSTS

ENV = os.getenv("MICROSHARE_ENV", "dev")
API_HOSTS = {"dev": "https://dapi.microshare.io", "prod": "https://api.microshare.io"}
API = API_HOSTS.get(ENV, API_HOSTS["dev"])


def check(label, passed, detail=""):
    status = "OK" if passed else "FAIL"
    msg = f"  {status:4s}  {label}"
    if detail:
        msg += f" — {detail}"
    print(msg)
    return passed


def info(label, detail=""):
    msg = f"        {label}"
    if detail:
        msg += f" — {detail}"
    print(msg)


def main():
    parser = argparse.ArgumentParser(description="Validate Microshare setup")
    parser.add_argument("--rectype", help="Check for a Robot on this recType and discover its device cluster")
    args = parser.parse_args()

    user = os.getenv("MICROSHARE_USER", "")
    password = os.getenv("MICROSHARE_PASS", "")

    print(f"Microshare setup validation ({ENV})\n")
    all_ok = True

    # 1. Credentials
    all_ok &= check("MICROSHARE_USER set", bool(user))
    all_ok &= check("MICROSHARE_PASS set", bool(password))
    if not user or not password:
        print("\n  Set MICROSHARE_USER and MICROSHARE_PASS environment variables.")
        sys.exit(1)

    # 2. Authentication
    try:
        token = get_token(user, password, ENV)
        all_ok &= check("Authentication", len(token) == 64, f"token {token[:8]}...")
    except Exception as e:
        all_ok &= check("Authentication", False, str(e))
        sys.exit(1)

    headers = {"Authorization": f"Bearer {token}"}

    # 3. List Robots
    robots = []
    try:
        r = requests.get(f"{API}/robo/*", headers=headers, timeout=30)
        robots = r.json().get("objs", [])
        all_ok &= check("List Robots", r.status_code == 200, f"{len(robots)} found")
    except Exception as e:
        all_ok &= check("List Robots", False, str(e))

    # 4. Data Lake access
    try:
        r = requests.get(
            f"{API}/share/io.microshare.openclose.unpacked",
            headers=headers,
            params={"limit": "1"},
            timeout=30,
        )
        total = r.json().get("meta", {}).get("totalCount", 0)
        all_ok &= check("Data Lake access", r.status_code == 200, f"{total} records visible")
    except Exception as e:
        all_ok &= check("Data Lake access", False, str(e))

    # 5. RecType-specific checks
    if args.rectype:
        rectype = args.rectype
        print()

        # 5a. Robot on this recType
        matches = [rb for rb in robots if rb.get("recType") == rectype]
        if matches:
            rb = matches[0]
            active = rb.get("data", {}).get("isActive", False)
            all_ok &= check(
                f"Robot on {rectype}",
                True,
                f"{'active' if active else 'INACTIVE'} — {rb.get('name', '?')}",
            )
            if not active:
                info("Warning: Robot exists but is inactive.")
        else:
            all_ok &= check(f"Robot on {rectype}", False, "no Robot found")

        # 5b. Device cluster on this recType
        try:
            r = requests.get(
                f"{API}/device/{rectype}",
                headers=headers,
                params={"details": "true", "discover": "true"},
                timeout=30,
            )
            clusters = r.json().get("objs", [])

            if clusters:
                total_devices = 0
                for cluster in clusters:
                    cd = cluster.get("data", {})
                    devices = cd.get("devices", [])
                    total_devices += len(devices)
                    cname = cluster.get("name", "?")
                    network = cd.get("network", {})
                    net_str = network.get("network", str(network)) if isinstance(network, dict) else str(network)

                    all_ok &= check(
                        f"Device cluster",
                        True,
                        f'"{cname}" — {len(devices)} devices, network: {net_str}',
                    )

                    # Show device twinning
                    for dev in devices[:5]:
                        loc = dev.get("meta", {}).get("location", [])
                        info(f"  {dev.get('id', '?'):30s} {' / '.join(loc) if loc else '(no location tags)'}")
                    if len(devices) > 5:
                        info(f"  ... and {len(devices) - 5} more")

                if total_devices == 0:
                    info("Warning: Cluster exists but has no devices registered.")
                    info("Add devices with IDs and location tags in Composer for twinning to work.")
            else:
                print(f"  WARN  Device cluster on {rectype} — none found")
                info("Robot will work but without location twinning.")
                info("Create a device cluster in Composer on this recType")
                info("and register your devices with location tags.")
                info("The Robot reads this for meta.device in unpacked records.")
        except Exception as e:
            all_ok &= check("Device cluster discovery", False, str(e))

    # Summary
    print()
    if all_ok:
        print("All checks passed.")
    else:
        print("Some checks failed — see above.")
    sys.exit(0 if all_ok else 1)


if __name__ == "__main__":
    main()

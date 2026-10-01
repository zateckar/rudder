#!/usr/bin/python3
"""Validate a served body, stage a hash marker, and check Traefik's loaded snapshot.

The marker shares routes.yml with the body, so even an empty routing document
has a positive reload signal. The API listener is bound only to loopback.
"""
import hashlib
import json
import os
import sys
import urllib.request


def read_body(path, expected_hash):
    data = open(path, "rb").read()
    if hashlib.sha256(data).hexdigest() != expected_hash:
        raise ValueError("routing body does not match the served hash")
    body = json.loads(data)
    if not isinstance(body.get("http"), dict):
        raise ValueError("no http section")
    for section in ("routers", "services", "middlewares"):
        if section in body["http"] and not isinstance(body["http"][section], dict):
            raise ValueError("invalid routing section")
    return body


def marker_name(content_hash):
    return "rudder-applied-" + content_hash


def prepare(body, content_hash, destination):
    body["http"].setdefault("routers", {})[marker_name(content_hash)] = {
        "rule": "Path(`/__rudder_applied/" + content_hash + "`)",
        "entryPoints": ["routing-admin"],
        "service": "api@internal",
    }
    with open(destination, "w") as output:
        json.dump(body, output, separators=(",", ":"))
    os.chmod(destination, 0o644)


def contains(actual, expected, field=""):
    """API adds defaults/runtime fields and qualifies provider references."""
    if isinstance(expected, dict):
        if not isinstance(actual, dict):
            return False
        folded = {key.lower(): value for key, value in actual.items()}
        return all(key.lower() in folded and contains(folded[key.lower()], value, key.lower())
                   for key, value in expected.items())
    if isinstance(expected, list):
        return isinstance(actual, list) and len(actual) == len(expected) and all(
            contains(a, e, field) for a, e in zip(actual, expected))
    if field in ("service", "middlewares") and isinstance(expected, str) and "@" not in expected:
        return actual in (expected, expected + "@file")
    return actual == expected


def verify(body, content_hash, previous, loaded):
    routers = loaded.get("routers", {})
    marker = routers.get(marker_name(content_hash) + "@file", {})
    if marker.get("status") != "enabled":
        raise ValueError("new routing body has not loaded")
    # One rawdata response is one installed snapshot, including backend URLs.
    for section in ("routers", "services"):
        actual = loaded.get(section, {})
        desired = body["http"].get(section, {})
        for name, definition in desired.items():
            item = actual.get(name + "@file", {})
            if item.get("status") != "enabled" or item.get("error") or not contains(item, definition):
                raise ValueError("routing component is not loaded: " + name)
        for name in previous.get("http", {}).get(section, {}):
            if name.startswith("rudder-applied-"):
                continue  # Marker replacement is checked independently below.
            if name not in desired and name + "@file" in actual:
                raise ValueError("obsolete routing component remains: " + name)
    if any(name.startswith("rudder-applied-") and name != marker_name(content_hash) + "@file"
           for name in routers):
        raise ValueError("previous routing marker remains")


def main():
    mode, source, content_hash = sys.argv[1:4]
    body = read_body(source, content_hash)
    if mode == "prepare":
        prepare(body, content_hash, sys.argv[4])
    elif mode == "verify":
        previous = json.load(open(sys.argv[4])) if os.path.isfile(sys.argv[4]) else {}
        # Proxy environment settings must never send this sensitive API outside the host.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open("http://127.0.0.1:8083/api/rawdata", timeout=2) as response:
            loaded = json.load(response)
        verify(body, content_hash, previous, loaded)
    else:
        raise ValueError("unknown verification operation")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)

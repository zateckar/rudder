"""Build an opt-in overlay from the current file-provider routers."""

import json
import sys


def overlay(routers, host, prefix, port):
    host_rule = f"Host(`{host}`)"
    websocket_rule = host_rule + ' && Header(`Connection`, `Upgrade`) && Header(`Upgrade`, `websocket`)'
    expected = {host_rule: "http", websocket_rule: "ws"}
    selected = {}
    for route in routers:
        if route.get("rule") not in expected or route.get("status") != "enabled":
            continue
        role = expected[route["rule"]]
        if (role in selected or route.get("provider") != "file" or
                route.get("entryPoints") != ["websecure"] or not route.get("tls") or
                (route.get("middlewares") or [None])[0] != "crowdsec@file" or
                not isinstance(route.get("priority"), int)):
            raise ValueError("Unexpected application router or CrowdSec chain")
        selected[role] = route
    if (selected.keys() != {"http", "ws"} or
            selected["http"]["service"] != selected["ws"]["service"] or
            selected["http"]["priority"] >= selected["ws"]["priority"] or
            selected["http"]["tls"] != selected["ws"]["tls"]):
        raise ValueError("Expected matching HTTPS and WebSocket application routers")

    tag, strip, enroll = (f"{prefix}-{suffix}" for suffix in ("tag", "strip", "enroll"))
    result = {}
    for role, route in selected.items():
        copy = {field: route[field] for field in ("entryPoints", "rule", "tls", "priority")}
        if "observability" in route:
            copy["observability"] = route["observability"]
        copy["service"] = route["service"]
        copy["priority"] += 1000
        copy["middlewares"] = [tag, *route["middlewares"], strip]
        result[f"{prefix}-{role}"] = copy

    base = selected["http"]
    result[enroll] = {
        "rule": host_rule + ' && Path(`/learn`) && (Method(`GET`) || Method(`POST`))',
        "entryPoints": base["entryPoints"],
        "middlewares": base["middlewares"],
        "service": enroll,
        "tls": base["tls"],
        "priority": selected["ws"]["priority"] + 1001,
    }
    endpoint = f"http://127.0.0.1:{port}"
    return {"http": {
        "routers": result,
        "middlewares": {
            tag: {"plugin": {"rudder-learning": {"originHost": host, "endpoint": endpoint + "/_capture"}}},
            strip: {"headers": {"customRequestHeaders": {"X-Crowdsec-Appsec-Transaction-Id": ""}}},
        },
        "services": {enroll: {"loadBalancer": {"servers": [{"url": endpoint}]}}},
    }}


if __name__ == "__main__":
    host, application_id, port = sys.argv[1:]
    json.dump(overlay(json.load(sys.stdin), host, f"rudder-learning-{application_id}", int(port)), sys.stdout)

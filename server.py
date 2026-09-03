#!/usr/bin/env python3
import copy
import http.cookies
import json
import os
import posixpath
import re
import threading
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA_FILE = ROOT / "data" / "state.json"
STATE_LOCK = threading.Lock()
CLIENT_ID_PATTERN = re.compile(r"[0-9a-f]{32}")


def default_config():
    return {"baseUrl": "", "key": "", "model": "gpt-4o-mini", "sessionId": ""}


def load_state():
    if DATA_FILE.exists():
        with DATA_FILE.open(encoding="utf-8") as handle:
            state = json.load(handle)
    else:
        state = {}
    state.setdefault("sessions", [])
    state.setdefault("config", default_config())
    state.setdefault("clients", {})
    for key, value in default_config().items():
        state["config"].setdefault(key, value)
    return state


def save_state(state):
    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    temporary = DATA_FILE.with_suffix(".tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(state, handle, ensure_ascii=False, indent=2)
    os.replace(temporary, DATA_FILE)


def public_state(state, client_id):
    config = {key: value for key, value in state["config"].items() if key != "key"}
    config["hasKey"] = bool(state["config"].get("key"))
    config["configured"] = bool(state["config"].get("baseUrl") and state["config"].get("key") and state["config"].get("model"))
    client = state["clients"].get(client_id, {})
    return {"sessions": copy.deepcopy(state["sessions"]), "config": config, "name": client.get("name", ""), "active": client.get("active")}


def apply_action(state, request, client_id):
    action = request.get("action")
    if action == "create_session":
        session = request["session"]
        if not any(item.get("id") == session.get("id") for item in state["sessions"]):
            state["sessions"].insert(0, session)
        state["clients"].setdefault(client_id, {})["active"] = session.get("id")
    elif action == "append_message":
        session = next(item for item in state["sessions"] if item.get("id") == request["sessionId"])
        message = request["message"]
        if not any(item.get("id") == message.get("id") for item in session["messages"]):
            session["messages"].append(message)
            if session.get("title") == "新的对话" and message.get("text"):
                session["title"] = str(message["text"])[:25]
    elif action == "update_message":
        session = next(item for item in state["sessions"] if item.get("id") == request["sessionId"])
        message = request["message"]
        current = next(item for item in session["messages"] if item.get("id") == message.get("id"))
        current.update(message)
    else:
        raise ValueError("unsupported state action")


def decoded_body(data):
    text = data.decode("utf-8", "replace")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text


def save_debug_record(session_id, message_id, request_data, response_data):
    if not session_id:
        return
    with STATE_LOCK:
        state = load_state()
        session = next((item for item in state["sessions"] if item.get("id") == session_id), None)
        if session is None:
            return
        session["debugRecord"] = {
            "messageId": message_id,
            "time": datetime.now(timezone.utc).isoformat(),
            "request": request_data,
            "response": response_data,
        }
        save_state(state)


class Handler(SimpleHTTPRequestHandler):
    def client_id(self):
        cookie = http.cookies.SimpleCookie(self.headers.get("Cookie", ""))
        value = cookie.get("teamask_client")
        client_id = value.value if value else ""
        return client_id if CLIENT_ID_PATTERN.fullmatch(client_id) else uuid.uuid4().hex

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        if path == "/api/state":
            client_id = self.client_id()
            with STATE_LOCK:
                response = public_state(load_state(), client_id)
            self.send_json(200, response, client_id)
            return
        normalized = posixpath.normpath(urllib.parse.unquote(path))
        if normalized == "/data" or normalized.startswith("/data/"):
            self.send_error(404)
            return
        super().do_GET()

    def do_POST(self):
        path = urllib.parse.urlsplit(self.path).path
        if path in {"/api/state", "/api/profile", "/api/config"}:
            self.handle_shared_post(path)
        elif path == "/api/ai":
            self.handle_ai()
        else:
            self.send_error(404)

    def handle_shared_post(self, path):
        client_id = self.client_id()
        try:
            request = self.read_json()
            with STATE_LOCK:
                state = load_state()
                if path == "/api/state":
                    apply_action(state, request, client_id)
                elif path == "/api/profile":
                    client = state["clients"].setdefault(client_id, {})
                    if "name" in request:
                        name = str(request.get("name", "")).strip()[:20]
                        if not name:
                            raise ValueError("name is required")
                        client["name"] = name
                    if request.get("active"):
                        client["active"] = str(request["active"])
                    if "name" not in request and not request.get("active"):
                        raise ValueError("profile value is required")
                else:
                    config = state["config"]
                    config.update({
                        "baseUrl": str(request.get("baseUrl", "")).strip(),
                        "model": str(request.get("model", "")).strip() or "gpt-4o-mini",
                        "sessionId": str(request.get("sessionId", "")).strip(),
                    })
                    if str(request.get("key", "")).strip():
                        config["key"] = str(request["key"]).strip()
                save_state(state)
                response = public_state(state, client_id)
            self.send_json(200, response, client_id)
        except (KeyError, StopIteration, TypeError, ValueError, json.JSONDecodeError) as error:
            self.send_json(400, {"error": str(error)}, client_id)
        except Exception as error:
            self.send_json(500, {"error": str(error)}, client_id)

    def handle_ai(self):
        request_data = None
        session_id = None
        message_id = None
        try:
            request = self.read_json()
            session_id = request.get("sessionId")
            message_id = request.get("messageId")
            with STATE_LOCK:
                config = copy.deepcopy(load_state()["config"])
            if not config.get("baseUrl") or not config.get("key") or not config.get("model"):
                self.send_json(400, {"error": "请先配置共享 API"})
                return
            body = request["body"]
            body["model"] = config["model"]
            headers = {"Content-Type": "application/json", "Authorization": "Bearer " + config["key"]}
            if config.get("sessionId"):
                headers["X-Session-ID"] = config["sessionId"]
            url = config["baseUrl"].rstrip("/") + "/chat/completions"
            request_data = {
                "method": "POST",
                "url": url,
                "headers": {**headers, "Authorization": "Bearer [REDACTED]"},
                "body": copy.deepcopy(body),
            }
            upstream = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST", headers=headers)
            with urllib.request.urlopen(upstream, timeout=120) as response:
                data, status = response.read(), response.status
                content_type = response.headers.get("Content-Type", "application/json")
                response_headers = dict(response.headers.items())
            save_debug_record(session_id, message_id, request_data, {
                "status": status,
                "headers": response_headers,
                "body": decoded_body(data),
            })
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except urllib.error.HTTPError as error:
            data = error.read()
            save_debug_record(session_id, message_id, request_data, {
                "status": error.code,
                "headers": dict(error.headers.items()) if error.headers else {},
                "body": decoded_body(data),
            })
            self.send_json(error.code, {"error": data.decode("utf-8", "replace")})
        except Exception as error:
            save_debug_record(session_id, message_id, request_data, {
                "status": None,
                "headers": {},
                "body": {"error": str(error)},
            })
            self.send_json(502, {"error": str(error)})

    def read_json(self):
        size = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(size))

    def send_json(self, status, value, client_id=None):
        data = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        if client_id:
            self.send_header("Set-Cookie", f"teamask_client={client_id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000")
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    os.chdir(ROOT)
    print(f"TeamAsk 已启动: http://localhost:{port}")
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()

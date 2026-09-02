# -*- coding: utf-8 -*-
"""
SillyTavern → AVATAR 桥接服务
================================
监听 http://127.0.0.1:8799/event ，接收 SillyTavern 扩展推送的角色回复，
解析出 情绪 / *动作* / 穿搭 三类信号，翻译成 AVATAR 本地总线命令发出。

用法：
  python st_avatar_bridge.py
  （token 放同目录 token.txt，映射表在同目录 mapping.json）

请求体格式（SillyTavern 扩展会按此发送，也支持手工 curl 测试）：
  POST /event  {"message": "角色回复全文", "emotion": "joy"}
  GET  /ping   健康检查
"""
import json
import os
import re
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
BASE_AVATAR = "http://127.0.0.1:47903"
LISTEN_PORT = 8799

# ---------------------------------------------------------------- token
def load_token():
    tok = os.environ.get("AVATAR_TOKEN", "").strip()
    if not tok:
        p = os.path.join(HERE, "token.txt")
        if os.path.exists(p):
            tok = open(p, encoding="utf-8-sig").read().strip()
    return tok

# ------------------------------------------------------------- mapping
def load_mapping():
    p = os.path.join(HERE, "mapping.json")
    with open(p, encoding="utf-8") as f:
        return json.load(f)

MAPPING = load_mapping()

# --------------------------------------------------------- avatar bus
_bus_lock = threading.Lock()
_last_play = {}          # {anim_key: ts} 做简易节流
ANIM_REPEAT_GUARD = 2.0  # 同一动作 2 秒内不重复触发


def avatar_command(token, command, payload):
    """向 AVATAR 总线发一条命令，返回 (status, resp_dict)"""
    req = urllib.request.Request(
        BASE_AVATAR + "/v1/command",
        data=json.dumps({"command": command, "payload": payload}).encode("utf-8"),
        method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, json.loads(r.read().decode("utf-8") or "{}")
    except Exception as e:  # noqa: BLE001
        return -1, {"error": str(e)}


def avatar_state(token):
    req = urllib.request.Request(BASE_AVATAR + "/v1/state", method="GET")
    req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return json.loads(r.read().decode("utf-8") or "{}")
    except Exception as e:  # noqa: BLE001
        return {"_error": str(e)}


def resolve_anim(name, animations):
    """把映射表里的名字解析成 AVATAR 实际可播的动画（先按 label 精确匹配，再子串匹配，再 id 匹配）"""
    if not name:
        return None
    for a in animations:
        if isinstance(a, dict):
            if name in (a.get("label"), a.get("id")):
                return a.get("id") or name
    for a in animations:
        label = (a.get("label") or "") if isinstance(a, dict) else str(a)
        if label and (name.lower() in label.lower()):
            return a.get("id") if isinstance(a, dict) else a
    return name  # 允许直接给内部 id，交给服务端判 404


# -------------------------------------------------------------- 解析
def extract_actions(text):
    """提取 *星号动作描写*，逐段在映射表里找动作关键词"""
    actions = []
    for seg in re.findall(r"\*([^*\n]+)\*", text or ""):
        for pattern, anim in MAPPING.get("action_keywords_to_animation", {}).items():
            if re.search(pattern, seg):
                actions.append((seg.strip(), anim))
    return actions


def extract_outfit(text, avatars):
    """在全文里找服装关键词，映射到 avatars 目录里的模型 id"""
    want = None
    for pattern, aid in MAPPING.get("outfit_keywords_to_avatar", {}).items():
        if aid and re.search(pattern, text or ""):
            want = aid
    if not want:
        return None, None
    # 映射表里填的既可以是 avatars 的 id，也可以是它的名字/标签
    for a in avatars:
        if isinstance(a, dict) and want in (a.get("id"), a.get("name"), a.get("label")):
            return want, a.get("id") or a.get("name")
    return want, want


def resolve_emotion(emotion, text, animations):
    """优先用 ST 情绪分类标签，否则从中文文本猜"""
    table = MAPPING.get("emotion_to_animation", {})
    anim = table.get((emotion or "").lower())
    if not anim:
        zh = MAPPING.get("chinese_emotion_to_animation", {})
        for kw, a in zh.items():
            if kw in (text or ""):
                anim = a
                break
    return resolve_anim(anim, animations) if anim else None


# ------------------------------------------------------------- 派发
def dispatch(message, emotion):
    token = load_token()
    if not token:
        return {"ok": False, "error": "token 未配置（bridge/token.txt）"}

    state = avatar_state(token)
    animations = state.get("animations") or []
    avatars = state.get("avatars") or []
    results = []

    # 1) 换装（avatar.set 只在有关键词时才发，避免每条消息都重置）
    want, aid = extract_outfit(message, avatars)
    if aid:
        st, r = avatar_command(token, "avatar.set", {"id": aid})
        results.append({"kind": "outfit", "to": aid, "status": st})
        time.sleep(0.3)  # 给换形象一点缓冲

    # 2) 动作
    for seg, anim in extract_actions(message):
        real = resolve_anim(anim, animations)
        if not real:
            results.append({"kind": "action", "text": seg, "want": anim,
                            "status": 404, "note": "映射值在 animations 目录里找不到"})
            continue
        now = time.time()
        if now - _last_play.get(real, 0) < ANIM_REPEAT_GUARD:
            continue
        _last_play[real] = now
        st, r = avatar_command(token, "animation.play",
                               {"id": real, "mode": "once"})
        results.append({"kind": "action", "text": seg, "anim": real, "status": st})

    # 3) 表情（没有显式情绪标签且没有动作命中时，才从文本猜一个；避免表情覆盖动作）
    if not results:
        emo_anim = resolve_emotion(emotion, message, animations)
        if emo_anim:
            st, r = avatar_command(token, "animation.play",
                                   {"id": emo_anim, "mode": "once"})
            results.append({"kind": "emotion", "from": emotion,
                            "anim": emo_anim, "status": st})

    return {"ok": True, "results": results}


# ----------------------------------------------------------- HTTP 层
# CORS 全开：云酒馆托管在 https 域名下，需允许其跨域访问本地桥接
CORS_HEADERS = [
    ("Access-Control-Allow-Origin", "*"),
    ("Access-Control-Allow-Methods", "GET, POST, OPTIONS"),
    ("Access-Control-Allow-Headers", "Content-Type, Authorization"),
]


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, obj, cors=True):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        if cors:
            for k, v in CORS_HEADERS:
                self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):  # noqa: N802  浏览器 CORS 预检
        self.send_response(204)
        for k, v in CORS_HEADERS:
            self.send_header(k, v)
        self.end_headers()

    def do_GET(self):  # noqa: N802
        if self.path == "/ping":
            self._send(200, {"ok": True, "service": "st-avatar-bridge",
                             "mapping": os.path.basename(os.path.join(HERE, "mapping.json"))})
        else:
            self._send(404, {"ok": False, "error": "use POST /event or GET /ping"})

    def do_POST(self):  # noqa: N802
        if self.path != "/event":
            self._send(404, {"ok": False, "error": "only /event"})
            return
        try:
            n = int(self.headers.get("Content-Length", 0))
            data = json.loads(self.rfile.read(n).decode("utf-8") or "{}")
        except Exception as e:  # noqa: BLE001
            self._send(400, {"ok": False, "error": "bad json: %s" % e})
            return
        result = dispatch(data.get("message", ""), data.get("emotion", ""))
        self._send(200, result)

    def log_message(self, fmt, *args):  # 静音默认日志
        pass


def main():
    srv = ThreadingHTTPServer(("127.0.0.1", LISTEN_PORT), Handler)
    print("ST→AVATAR 桥接已启动: http://127.0.0.1:%d/event" % LISTEN_PORT)
    print("映射表: %s   （改完保存即生效，无需重启）" % os.path.join(HERE, "mapping.json"))
    print("按 Ctrl+C 退出")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n再见")


if __name__ == "__main__":
    main()

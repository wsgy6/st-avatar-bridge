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

# ------- Qwen3 剧情分析服务（方案A：流式逐句 LLM 判断动作/情绪）-------
QWEN_URL = os.environ.get("QWEN_URL", "http://127.0.0.1:8080/v1/chat/completions")
QWEN_KEY = os.environ.get("QWEN_KEY", "peach-herctic-8b-2026")
QWEN_MODEL = os.environ.get("QWEN_MODEL", "Qwen3-8B-heretic.Q4_K_M.gguf")
_qwen_lock = threading.Lock()   # -np1 单槽，必须串行调 Qwen3

QWEN_JSON_SCHEMA = {
    "type": "object",
    "properties": {
        "emotion": {"type": "string", "enum": ["joy", "angry", "sad", "calm", "excited"]},
        "action": {"type": "string", "description": "人物即时动作指令，用中文短句如 挥手/转身/蹲下/点头 描述"},
        "who": {"type": "string", "description": "正在做动作的角色名"},
    },
    "required": ["emotion", "action", "who"],
}


# ---------------------------------------------------------------- token
def load_token():
    tok = os.environ.get("AVATAR_TOKEN", "").strip()
    if not tok:
        p = os.path.join(HERE, "token.txt")
        if os.path.exists(p):
            tok = open(p, encoding="utf-8-sig").read().strip()
    return tok

# ------------------------------------------------------------- mapping
MAPPING_PATH = os.path.join(HERE, "mapping.json")
_mapping_cache = {"mtime": 0, "data": {}}


def get_mapping():
    """带文件修改时间缓存的热重载：mapping.json 保存后自动生效，无需重启"""
    try:
        mtime = os.path.getmtime(MAPPING_PATH)
    except OSError:
        return _mapping_cache["data"]
    if mtime != _mapping_cache["mtime"]:
        try:
            with open(MAPPING_PATH, encoding="utf-8") as f:
                _mapping_cache["data"] = json.load(f)
            _mapping_cache["mtime"] = mtime
            print("[bridge] mapping.json 已热重载")
        except Exception as e:  # noqa: BLE001
            print("[bridge] mapping.json 加载失败，沿用上次:", e)
    return _mapping_cache["data"]


MAPPING = get_mapping()

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


# ---------------------------------------------------------- Qwen3 分析
def analyze_with_qwen3(sentence, timeout=30):
    """调本地 Qwen3 分析一句剧情，返回 {'emotion','action','who'}。失败返回 None"""
    if not sentence or not sentence.strip():
        return None
    payload = {
        "model": QWEN_MODEL,
        "messages": [
            {"role": "system", "content": "你是桌面虚拟角色的动作/情绪解析器。输入一句剧情文本，判断其中做动作的角色、动作类型、整体情绪。动作用中文短词描述(如挥手/转身/蹲下/点头/跳起/坐下/摊手)。只输出 JSON。"},
            {"role": "user", "content": sentence},
        ],
        "temperature": 0.3,
        "seed": 42,
        "max_tokens": 200,
        "chat_template_kwargs": {"enable_thinking": False},
        "response_format": {"type": "json_schema",
                            "json_schema": {"name": "action_parse", "schema": QWEN_JSON_SCHEMA}},
    }
    req = urllib.request.Request(
        QWEN_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": "Bearer " + QWEN_KEY, "Content-Type": "application/json"},
        method="POST")
    try:
        with _qwen_lock:  # 单槽串行
            with urllib.request.urlopen(req, timeout=timeout) as r:
                resp = json.loads(r.read().decode("utf-8"))
        content = resp["choices"][0]["message"]["content"]
        parsed = json.loads(content) if isinstance(content, str) else content
        return {k: str(parsed.get(k, "") or "").strip() for k in ("emotion", "action", "who")}
    except Exception as e:  # noqa: BLE001
        print(f"[bridge] Qwen3 分析失败: {e}")
        return None


# action 中文关键词 → AVATAR 动画。复用 action_keywords_to_animation，加英文标签映射
def resolve_action_to_anim(action_text, animations):
    """把 Qwen3 返回的 action 中文/英文描述解析成可播动画"""
    if not action_text:
        return None
    # 1) 直接按 label/id 精确找
    hit = resolve_anim(action_text, animations)
    if hit and hit != action_text:
        return hit
    # 2) 在 action 文本里找 mapping 里的动作关键词
    for pattern, anim in get_mapping().get("action_keywords_to_animation", {}).items():
        if re.search(pattern, action_text):
            return resolve_anim(anim, animations)
    # 3) 英文动作标签映射
    en_map = {
        "wave|greeting|raise.*hand|hello": "Greeting",
        "spin|turn|rotate|twirl": "Spin",
        "squat|crouch|duck|sit|kneel": "Squat",
        "shoot|aim|point|gun|finger": "Shoot",
        "pose|model|stand": "Model Pose",
        "peace|sign|heart|v.*hand": "Peace Sign",
        "show|display|present|full.*body": "Show Full Body",
    }
    low = action_text.lower()
    for pat, anim in en_map.items():
        if re.search(pat, low):
            return resolve_anim(anim, animations)
    return None


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
        for pattern, anim in get_mapping().get("action_keywords_to_animation", {}).items():
            if re.search(pattern, seg):
                actions.append((seg.strip(), anim))
    return actions


def extract_outfit(text, avatars):
    """在全文里找服装关键词，映射到 avatars 目录里的模型 id"""
    want = None
    for pattern, aid in get_mapping().get("outfit_keywords_to_avatar", {}).items():
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
    table = get_mapping().get("emotion_to_animation", {})
    anim = table.get((emotion or "").lower())
    if not anim:
        zh = get_mapping().get("chinese_emotion_to_animation", {})
        for kw, a in zh.items():
            if kw in (text or ""):
                anim = a
                break
    return resolve_anim(anim, animations) if anim else None


# ------------------------------------------------------------- 派发
# 该源码版 AVATAR 的 mode:"once" 有 bug 不生效（select 有效）。
# 采用"保持到剧情变"策略：有动作/情绪信号 → select 切换并保持；
# 一条消息既无动作词也无情绪映射（纯对话）→ 恢复 default 待机。
ACTIVE_DURATION = 15.0  # (保留备用，默认不再自动回待机)


def play_action_select(token, anim):
    """用 select 播动画并保持到下一次切换。anim 为已解析的 label 或 id"""
    if not anim:
        return -1, {"error": "empty anim"}
    st, r = avatar_command(token, "animation.play",
                           {"id": anim, "mode": "select"})
    return st, r


def dispatch(message, emotion):
    token = load_token()
    if not token:
        return {"ok": False, "error": "token 未配置（bridge/token.txt）"}

    state = avatar_state(token)
    animations = state.get("animations") or []
    avatars = state.get("avatars") or []
    results = []
    acted = False  # 本条是否有动作/情绪意图（用于是否恢复待机）

    # 1) 换装（avatar.set 只在有关键词时才发，避免每条消息都重置）
    want, aid = extract_outfit(message, avatars)
    if aid:
        st, r = avatar_command(token, "avatar.set", {"id": aid})
        results.append({"kind": "outfit", "to": aid, "status": st})
        acted = True
        time.sleep(0.3)  # 给换形象一点缓冲

    # 2) 动作
    for seg, anim in extract_actions(message):
        real = resolve_anim(anim, animations)
        if not real:
            results.append({"kind": "action", "text": seg, "want": anim,
                            "status": 404, "note": "映射值在 animations 目录里找不到"})
            acted = True
            continue
        acted = True
        now = time.time()
        if now - _last_play.get(real, 0) < ANIM_REPEAT_GUARD:
            # 节流内重复：维持当前动作不打断
            continue
        _last_play[real] = now
        st, r = play_action_select(token, real)
        results.append({"kind": "action", "text": seg, "anim": real, "status": st})

    # 3) 表情：有动作/换装时不猜情绪避免覆盖；否则从情绪标签/文本猜
    if not acted:
        emo_anim = resolve_emotion(emotion, message, animations)
        if emo_anim:
            acted = True
            st, r = play_action_select(token, emo_anim)
            results.append({"kind": "emotion", "from": emotion,
                            "anim": emo_anim, "status": st})

    # 4) 纯对话（无任何动作/情绪/换装意图）：恢复 default 待机
    if not acted:
        st, r = avatar_command(token, "animation.default", {})
        results.append({"kind": "idle", "action": "default", "status": st})

    return {"ok": True, "results": results}


# ------------------------------------------------------- 流式逐句分析
_last_analyzed = 0.0      # 上次分析时间戳
_last_analyzed_sent = ""  # 上次分析的句子(去重)
Qwen  = "qwen3"           # noqa: F841 占位
ANALYZE_COOLDOWN = 1.2    # 两次分析最小间隔(s)，防句子风暴


def analyze_sentence(sentence):
    """流式句子专用：调 Qwen3 分析动作/情绪 → 播放。返回结果 dict"""
    global _last_analyzed, _last_analyzed_sent
    if not sentence or not sentence.strip():
        return {"ok": True, "results": []}

    token = load_token()
    if not token:
        return {"ok": False, "error": "token 未配置"}

    # 去重：同一句跳过
    if sentence == _last_analyzed_sent:
        return {"ok": True, "results": []}
    _last_analyzed_sent = sentence

    # 节流：连续句子太快则合并处理（交给下一条）
    now = time.time()
    if now - _last_analyzed < ANALYZE_COOLDOWN:
        return {"ok": True, "results": []}
    _last_analyzed = now

    # 调 Qwen3 分析
    parsed = analyze_with_qwen3(sentence)
    if not parsed:
        return {"ok": False, "error": "Qwen3 分析失败"}
    print(f"[bridge] Qwen3 分析: emotion={parsed.get('emotion')!r} action={parsed.get('action')!r} who={parsed.get('who')!r}")

    state = avatar_state(token)
    animations = state.get("animations") or []
    results = []
    acted = False

    # 1) action → 动画
    act_anim = resolve_action_to_anim(parsed.get("action"), animations)
    if act_anim:
        now2 = time.time()
        if now2 - _last_play.get(act_anim, 0) >= ANIM_REPEAT_GUARD:
            _last_play[act_anim] = now2
            st, r = play_action_select(token, act_anim)
            results.append({"kind": "action", "action": parsed.get("action"),
                            "who": parsed.get("who"), "anim": act_anim, "status": st})
            acted = True

    # 2) 若 action 没映射出动画，fallback 到 emotion → 动画
    if not acted and parsed.get("emotion"):
        emo_anim = resolve_anim(
            get_mapping().get("emotion_to_animation", {}).get(parsed.get("emotion")), animations)
        if emo_anim:
            now2 = time.time()
            if now2 - _last_play.get(emo_anim, 0) >= ANIM_REPEAT_GUARD:
                _last_play[emo_anim] = now2
                st, r = play_action_select(token, emo_anim)
                results.append({"kind": "emotion", "emotion": parsed.get("emotion"),
                                "anim": emo_anim, "status": st})
                acted = True

    # 3) 这句没有可演的（纯对话无动作）→ 不强制回待机(流式中间句不该打断)
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
        if self.path not in ("/event", "/analyze"):
            self._send(404, {"ok": False, "error": "only /event or /analyze"})
            return
        try:
            n = int(self.headers.get("Content-Length", 0))
            data = json.loads(self.rfile.read(n).decode("utf-8") or "{}")
        except Exception as e:  # noqa: BLE001
            self._send(400, {"ok": False, "error": "bad json: %s" % e})
            return
        msg = (data.get("message") or data.get("sentence") or "")[:60].replace("\n", " ")
        print(f"[bridge] 收到 {self.path} → emotion={data.get('emotion','')!r} msg={msg!r}")
        if self.path == "/analyze":
            result = analyze_sentence(data.get("sentence") or data.get("message") or "")
        else:
            result = dispatch(data.get("message", ""), data.get("emotion", ""))
        print(f"[bridge] 结果: {json.dumps(result, ensure_ascii=False)}")
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

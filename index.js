// SillyTavern → AVATAR 桥接扩展（方案A：流式逐句驱动）
// 累积流式文本 → 用状态机剥离 HTML 注释/草稿 → 按完整句发桥接（Qwen3 分析）
// 兼容性：零模块 import，全局 SillyTavern.getContext()

const BRIDGE_URL = "http://127.0.0.1:8799/analyze";
let textBuf = "";          // 已剥离注释的可见正文缓冲
let inComment = false;     // 是否在 HTML 注释内
let genActive = false;
let busy = false;
const SENT_END = /[。！？!?\n…]/;

function getCtx() {
    const root = window.SillyTavern || window.sillytavern;
    return root && typeof root.getContext === "function" ? root.getContext() : null;
}
function post(payload) {
    return fetch(BRIDGE_URL, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload) }).then(r => r.json()).catch(() => ({ results: [] }));
}

// 把流入的字符追加到缓冲（剥离 HTML 注释）。返回是否新增了可见正文。
function pushChars(chunk) {
    if (!chunk) return;
    let i = 0;
    while (i < chunk.length) {
        if (inComment) {
            const close = chunk.indexOf("-->", i);
            if (close === -1) { return; }        // 注释未闭合，丢弃剩余
            inComment = false;
            i = close + 3;
            // 注释后可能紧跟正文或换行，自然继续
        } else {
            const open = chunk.indexOf("<!--", i);
            if (open === -1) { textBuf += chunk.slice(i); return; }
            textBuf += chunk.slice(i, open);
            inComment = true;
            i = open + 4;
        }
    }
}

function analyzeSentence(s) {
    if (busy) return;
    const clean = s.trim();
    if (clean.length < 6) return;
    // 过滤纯标点/无意义
    if (!/[\u4e00-\u9fa5a-zA-Z]/.test(clean)) return;
    busy = true;
    console.log("[AVATAR-Bridge] 分析:", clean.replace(/\s+/g, " ").slice(0, 40));
    post({ message: clean }).then(res => {
        if (res?.results?.length) console.log("[AVATAR-Bridge] →", JSON.stringify(res.results));
        busy = false;
    }).catch(() => { busy = false; });
}

// 从缓冲尾部提取一个完整句子并触发分析
function emitCompleteSentence() {
    if (!genActive || busy) return;
    // 找缓冲里第一个句子结束符
    let cut = -1;
    for (let i = 0; i < textBuf.length; i++) {
        if (SENT_END.test(textBuf[i])) { cut = i + 1; break; }
    }
    if (cut < 0) return;                 // 无完整句
    const sent = textBuf.slice(0, cut);
    textBuf = textBuf.slice(cut);
    analyzeSentence(sent);
}

function setup() {
    const ctx = getCtx();
    if (!ctx) { setTimeout(setup, 800); return; }
    const et = ctx.eventTypes || ctx.event_types || {};
    const evt = ctx.eventSource;
    if (!evt || !evt.on) { console.error("[AVATAR-Bridge] 无 eventSource"); return; }

    const startGen = () => { genActive = true; textBuf = ""; inComment = false; };
    const endGen = () => {
        genActive = false;
        // 尾部残余正文（未到句号也被截断）——分析最后一段，但避免重复
        if (textBuf.trim().length >= 10) analyzeSentence(textBuf.trim());
        textBuf = ""; inComment = false;
    };
    if (et.GENERATION_STARTED) evt.on(et.GENERATION_STARTED, startGen);
    if (et.GENERATION_ENDED) evt.on(et.GENERATION_ENDED, endGen);
    if (et.GENERATION_STOPPED) evt.on(et.GENERATION_STOPPED, endGen);

    const tokenEvt = et.STREAM_TOKEN_RECEIVED;
    if (tokenEvt) {
        evt.on(tokenEvt, (tok) => {
            if (!genActive) genActive = true;
            let t = "";
            if (typeof tok === "string") t = tok;
            else if (tok) t = tok?.text ?? tok?.delta?.content ?? tok?.content ?? "";
            if (t) { pushChars(t); emitCompleteSentence(); }
        });
        console.log("[AVATAR-Bridge] 已监听流式 token（HTML注释过滤）");
    } else {
        console.log("[AVATAR-Bridge] 无流式事件 → 消息完成模式");
        const recv = et.MESSAGE_RECEIVED;
        if (recv) evt.on(recv, (id) => {
            try {
                const msg = ctx.chat?.[id];
                if (!msg || msg.is_user || msg.is_system) return;
                let raw = msg.mes ?? msg.message ?? "";
                // 剥离注释后分析末尾
                let tmp = raw.replace(/<!--[\s\S]*?-->/g, "").trim();
                if (tmp.length >= 10) post({ message: tmp.slice(-300) });
            } catch (e) { /* ignore */ }
        });
    }

    console.log("[AVATAR-Bridge] 扩展已加载 →", BRIDGE_URL);
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => setTimeout(setup, 500));
} else { setTimeout(setup, 500); }
console.log("[AVATAR-Bridge] 来源:", window.location.origin);
fetch("http://127.0.0.1:8799/ping").then(r => r.json())
    .then(d => console.log("[AVATAR-Bridge] ✅ 桥接可达:", d))
    .catch(e => console.log("[AVATAR-Bridge] ❌ 桥接不可达:", e.message));

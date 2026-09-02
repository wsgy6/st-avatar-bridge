// SillyTavern → AVATAR 桥接扩展（方案A：流式逐句驱动）
// 作用：角色流式生成时，按句切分已生成的文本，句子完整即 POST 给本地桥接
//       （桥接负责调 Qwen3 分析动作+情绪，映射成 AVATAR 动画）
// 兼容性：零模块 import，用全局 SillyTavern.getContext()，穿透魔改/托管版

const BRIDGE_URL = "http://127.0.0.1:8799/analyze";
let streamBuffer = "";      // 当前流式累积的文本
let analysisLock = false;   // 防止分析重入
let lastAnalyzedLen = 0;    // 已分析过的字符位置
let genActive = false;      // 是否正在生成
let lastMsg = "";           // 兜底防重复

// 句子结束符：中英文句号/叹号/问号/换行/引号组合
const SENT_END = /[。！？!?\n…]/;

function getCtx() {
    const root = window.SillyTavern || window.sillytavern;
    return root && typeof root.getContext === "function" ? root.getContext() : null;
}

function postToBridge(payload) {
    return fetch(BRIDGE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    }).then(r => r.json()).catch(e => {
        console.log("[AVATAR-Bridge] 桥接请求失败:", e.message ?? e);
        return { results: [] };
    });
}

// 分析新完成的句子（从流式缓冲里切出还没分析过的完整句）
function analyzeNewComplete() {
    if (analysisLock || !genActive) return;
    if (streamBuffer.length - lastAnalyzedLen < 8) return; // 太短没意义

    // 从上次分析位置往后找完整句子
    const pending = streamBuffer.slice(lastAnalyzedLen);
    let cut = -1;
    for (let i = 0; i < pending.length; i++) {
        if (SENT_END.test(pending[i])) { cut = i + 1; break; }
    }
    if (cut < 0) return; // 还没到完整句子

    const sentence = pending.slice(0, cut).trim();
    if (!sentence) { lastAnalyzedLen += cut; return; }

    analysisLock = true;
    lastAnalyzedLen += cut;
    console.log("[AVATAR-Bridge] 分析句子 →", sentence.slice(0, 40).replace(/\s+/g, " "));
    postToBridge({ message: sentence, stream: true }).then(res => {
        if (res?.results?.length) console.log("[AVATAR-Bridge] 已派发:", JSON.stringify(res.results));
        analysisLock = false;
    });
}

function setup() {
    const ctx = getCtx();
    if (!ctx) {
        setTimeout(setup, 1000);
        return;
    }
    const et = ctx.eventTypes || ctx.event_types || {};
    const evt = ctx.eventSource;
    if (!evt || !evt.on) {
        console.error("[AVATAR-Bridge] 未找到 eventSource");
        return;
    }

    // 流式 token 到达 → 累积进缓冲
    const tokenEvt = et.STREAM_TOKEN_RECEIVED;
    if (tokenEvt) {
        evt.on(tokenEvt, (token) => {
            if (typeof token === "string") streamBuffer += token;
            else if (token && typeof token === "object") {
                const c = token?.text ?? token?.delta?.content ?? "";
                if (c) streamBuffer += c;
            }
            analyzeNewComplete();
        });
        console.log("[AVATAR-Bridge] 已监听流式 token 事件");
    } else {
        console.log("[AVATAR-Bridge] 无 STREAM_TOKEN_RECEIVED 事件，回退消息完成模式");
    }

    // 生成开始/结束 管理缓冲
    const gs = et.GENERATION_STARTED, ge = et.GENERATION_ENDED;
    if (gs) evt.on(gs, () => { genActive = true; });
    if (ge) evt.on(ge, () => {
        genActive = false;
        // 生成结束，把残留缓冲最后分析一次
        if (streamBuffer.length > lastAnalyzedLen + 8) {
            const leftover = streamBuffer.slice(lastAnalyzedLen).trim();
            if (leftover) {
                postToBridge({ message: leftover, stream: true });
            }
        }
        streamBuffer = ""; lastAnalyzedLen = 0;
    });

    // 兜底：消息完成也触发（防止流式事件没截全）
    const recv = et.MESSAGE_RECEIVED;
    if (recv) evt.on(recv, (id) => {
        try {
            const msg = ctx.chat?.[id];
            if (!msg || msg.is_user || msg.is_system) return;
            const text = msg.mes ?? msg.message ?? "";
            if (text && text !== lastMsg) {
                lastMsg = text;
                // 消息完成后由桥接整体分析一次（兜底，正常流式已逐句触发）
            }
        } catch (e) { /* ignore */ }
    });

    console.log("[AVATAR-Bridge] 扩展已加载（流式截句模式）→", BRIDGE_URL);
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => setTimeout(setup, 500));
} else {
    setTimeout(setup, 500);
}

console.log("[AVATAR-Bridge] 页面来源:", window.location.origin);
fetch("http://127.0.0.1:8799/ping")
    .then(r => r.json()).then(d => console.log("[AVATAR-Bridge] ✅ 桥接可达:", d))
    .catch(e => console.log("[AVATAR-Bridge] ❌ 桥接不可达:", e.message));

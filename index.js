// SillyTavern → AVATAR 桥接扩展
// 作用：角色每条回复渲染后，把全文 + 情绪标签 POST 给本机桥接服务 (127.0.0.1:8799)
//
// 兼容性说明：完全不使用模块 import（不同 ST 版本 script.js/extensions.js 导出不同，
// 魔改版/托管版更容易崩）。改用官方全局对象 SillyTavern.getContext()，任何版本通用。
// 参考：https://docs.sillytavern.app/for-contributors/writing-extensions

const BRIDGE_URL = "http://127.0.0.1:8799/event";
let lastHash = "";   // 防重复推送
let ready = false;

function getCtx() {
    // 标准版与部分 MOD 都暴露全局 SillyTavern；兜底读 window
    const root = window.SillyTavern || window.sillytavern;
    return root && typeof root.getContext === "function" ? root.getContext() : null;
}

function currentEventTypes(ctx) {
    // eventTypes 可能在 ctx.eventTypes 或 ctx.event_types（版本差异）
    return ctx.eventTypes || ctx.event_types || {};
}

async function pushToBridge(messageId) {
    try {
        const ctx = getCtx();
        if (!ctx || !ctx.chat) return;
        const msg = ctx.chat[messageId];
        if (!msg || msg.is_user || msg.is_system) return;

        const text = msg.mes ?? msg.message ?? "";
        if (!text.trim()) return;

        // 防重复
        const hash = messageId + ":" + text.length + ":" + text.slice(-16);
        if (lastHash === hash) return;
        lastHash = hash;

        // 情绪标签（若有 classify/Character Expressions 扩展写入）
        const emotion = msg.extra?.emotion ?? "";

        const resp = await fetch(BRIDGE_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: text, emotion: emotion }),
        });
        if (!resp.ok) {
            console.warn("[AVATAR-Bridge] 桥接服务返回", resp.status);
        } else {
            const data = await resp.json();
            if (data?.results?.length) {
                console.log("[AVATAR-Bridge] 已派发:", data.results);
            }
        }
    } catch (err) {
        console.debug("[AVATAR-Bridge] 推送失败:", err.message ?? err);
    }
}

function setup() {
    const ctx = getCtx();
    if (!ctx) {
        // 全局对象还没就绪，稍后重试
        setTimeout(setup, 1000);
        return;
    }
    const et = currentEventTypes(ctx);
    const evt = ctx.eventSource;
    if (!evt || !evt.on) {
        console.error("[AVATAR-Bridge] 未找到 eventSource，扩展无法监听。你的 SillyTavern 版本可能不兼容");
        return;
    }
    evt.on(et.MESSAGE_RECEIVED, (id) => pushToBridge(id));
    evt.on(et.CHARACTER_MESSAGE_RENDERED, (id) => pushToBridge(id));
    ready = true;
    console.log("[AVATAR-Bridge] 扩展已加载并监听消息事件 →", BRIDGE_URL);
}

// 页面加载后注册；若窗口已就绪事件仍可能未绑定，延迟一次确保
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => setTimeout(setup, 500));
} else {
    setTimeout(setup, 500);
}

console.log("[AVATAR-Bridge] 页面来源:", window.location.origin);

// 桥接可达性自检
try {
    fetch("http://127.0.0.1:8799/ping")
        .then(r => r.json())
        .then(d => console.log("[AVATAR-Bridge] ✅ 本地桥接可达:", d))
        .catch(e => console.log("[AVATAR-Bridge] ❌ 本地桥接不可达:", e.message));
} catch (e) { /* ignore */ }

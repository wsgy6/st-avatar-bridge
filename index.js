// SillyTavern → AVATAR 桥接扩展
// 作用：角色每条回复渲染后，把全文 + 情绪标签 POST 给本机桥接服务 (127.0.0.1:8799)
// 兼容性：零模块 import，用全局 SillyTavern.getContext()，穿透魔改/托管版

const BRIDGE_URL = "http://127.0.0.1:8799/event";
let lastHash = "";
let ready = false;
let ctxSnapshot = null;   // 保留 getContext 引用，便于诊断

function getCtx() {
    const root = window.SillyTavern || window.sillytavern;
    return root && typeof root.getContext === "function" ? root.getContext() : null;
}

async function pushToBridge(messageId) {
    try {
        console.log("[AVATAR-Bridge][诊断] 事件触发, messageId=", messageId);
        const ctx = getCtx();
        if (!ctx) { console.log("[AVATAR-Bridge][诊断] ❌ getContext 拿不到"); return; }
        if (!ctx.chat) { console.log("[AVATAR-Bridge][诊断] ❌ ctx.chat 不存在"); return; }
        const msg = ctx.chat[messageId];
        if (!msg) { console.log("[AVATAR-Bridge][诊断] ❌ 找不到消息 index=", messageId); return; }
        if (msg.is_user || msg.is_system) { console.log("[AVATAR-Bridge][诊断] 跳过(用户/系统消息)"); return; }

        const text = msg.mes ?? msg.message ?? "";
        if (!text.trim()) { console.log("[AVATAR-Bridge][诊断] ❌ 消息为空"); return; }

        // 防重复
        const hash = messageId + ":" + text.length + ":" + text.slice(-16);
        if (lastHash === hash) { console.log("[AVATAR-Bridge][诊断] 重复消息跳过"); return; }
        lastHash = hash;

        const emotion = msg.extra?.emotion ?? "";
        console.log("[AVATAR-Bridge][诊断] 角色消息长度=", text.length, "emotion=", emotion, "文本前40:", text.slice(0, 40).replace(/\n/g, " "));

        console.log("[AVATAR-Bridge][诊断] 准备 POST →", BRIDGE_URL);
        const resp = await fetch(BRIDGE_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: text, emotion: emotion }),
        });
        console.log("[AVATAR-Bridge][诊断] POST 返回状态=", resp.status);
        if (!resp.ok) {
            console.warn("[AVATAR-Bridge] 桥接服务返回", resp.status);
        } else {
            const data = await resp.json();
            console.log("[AVATAR-Bridge] 已派发:", JSON.stringify(data.results ?? data));
        }
    } catch (err) {
        console.log("[AVATAR-Bridge][诊断] ❌ 推送异常:", err.message ?? err);
    }
}

function setup() {
    const ctx = getCtx();
    if (!ctx) {
        console.log("[AVATAR-Bridge][诊断] 全局对象未就绪，1秒后重试...");
        setTimeout(setup, 1000);
        return;
    }
    ctxSnapshot = ctx;
    console.log("[AVATAR-Bridge][诊断] getContext OK。chat 长度=", (ctx.chat || []).length,
                "| 有 eventSource:", !!ctx.eventSource,
                "| 有 eventTypes:", !!(ctx.eventTypes || ctx.event_types));
    const et = currentEventTypes(ctx);
    const evt = ctx.eventSource;
    if (!evt || !evt.on) {
        console.error("[AVATAR-Bridge] ❌ 未找到 eventSource。可用键:", Object.keys(ctx).join(", "));
        return;
    }
    const recvName = et.MESSAGE_RECEIVED;
    const renderName = et.CHARACTER_MESSAGE_RENDERED;
    console.log("[AVATAR-Bridge][诊断] 事件名: MESSAGE_RECEIVED=", recvName, "| CHARACTER_MESSAGE_RENDERED=", renderName);
    evt.on(recvName, (id) => pushToBridge(id));
    evt.on(renderName, (id) => pushToBridge(id));
    ready = true;
    console.log("[AVATAR-Bridge] 扩展已加载并监听消息事件 →", BRIDGE_URL);
}

function currentEventTypes(ctx) {
    return ctx.eventTypes || ctx.event_types || {};
}

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

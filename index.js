// SillyTavern → AVATAR 桥接扩展
// 作用：角色每条回复渲染后，把全文 + 情绪标签 POST 给本机桥接服务 (127.0.0.1:8799)
// 采用官方推荐的 getContext() 模式，从标准入口导入，兼容主流版本

// eventSource / event_types 来自 script.js（全局事件系统）
import { eventSource, event_types } from "../../../script.js";
// getContext() 来自 extensions.js（官方导出的上下文入口）
import { getContext } from "../../../extensions.js";

const BRIDGE_URL = "http://127.0.0.1:8799/event";
let lastHash = ""; // 防重复推送

function getMessage(index) {
    try {
        const context = getContext();
        return (context.chat || [])[index];
    } catch (e) {
        console.debug("[AVATAR-Bridge] getContext 失败:", e.message ?? e);
        return null;
    }
}

async function pushToBridge(messageId) {
    try {
        const msg = getMessage(messageId);
        if (!msg || msg.is_user || msg.is_system) return;

        const text = msg.mes ?? msg.message ?? "";
        if (!text.trim()) return;

        // 防重复：同一消息可能触发多次事件
        const hash = messageId + ":" + text.length + ":" + text.slice(-16);
        if (lastHash === hash) return;
        lastHash = hash;

        // 情绪：SillyTavern 的 classify 扩展会把情绪写进 msg.extra
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
        // 桥接服务没开时不刷屏，只在控制台留一句
        console.debug("[AVATAR-Bridge] 无法连接桥接服务:", err.message ?? err);
    }
}

// 角色消息生成完成（非流式主通道）
eventSource.on(event_types.MESSAGE_RECEIVED, (messageId) => pushToBridge(messageId));
// 渲染完成（流式输出结束后也会触发）
eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (messageId) => pushToBridge(messageId));

console.log("[AVATAR-Bridge] 扩展已加载 → http://127.0.0.1:8799/event");
console.log("[AVATAR-Bridge] 页面来源:", window.location.origin);

// 桥接可达性自检
try {
    fetch("http://127.0.0.1:8799/ping")
        .then(r => r.json())
        .then(d => console.log("[AVATAR-Bridge] ✅ 本地桥接可达:", d))
        .catch(e => console.log("[AVATAR-Bridge] ❌ 本地桥接不可达:", e.message));
} catch (e) { /* ignore */ }

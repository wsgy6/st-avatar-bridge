// SillyTavern → AVATAR 桥接扩展
// 安装位置：<SillyTavern 目录>/scripts/extensions/third-party/st-avatar-bridge/
// 作用：角色每条回复渲染后，把全文 + 情绪标签 POST 给本机桥接服务 (127.0.0.1:8799)

import { eventSource, event_types, chat } from "../../../extensions.js";

const BRIDGE_URL = "http://127.0.0.1:8799/event";
const lastPushed = new Map(); // messageId -> message hash，防重复推送

async function pushToBridge(messageId) {
    try {
        const msg = chat[messageId];
        if (!msg || msg.is_user || msg.is_system) return;

        const text = msg.mes ?? msg.message ?? "";
        if (!text.trim()) return;

        // 防重复：同一消息渲染事件可能触发多次
        const hash = messageId + ":" + text.length + ":" + text.slice(-16);
        if (lastPushed.get("last") === hash) return;
        lastPushed.set("last", hash);

        // 情绪：优先取 classify 扩展写入的标签（SillyTavern 的 Character Expressions）
        const emotion = msg.extra?.emotion ?? "";

        const resp = await fetch(BRIDGE_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: text, emotion: emotion }),
        });
        if (!resp.ok) console.warn("[AVATAR-Bridge] 桥接服务返回", resp.status);
        else {
            const data = await resp.json();
            if (data?.results?.length) {
                console.log("[AVATAR-Bridge] 已派发:", data.results);
            }
        }
    } catch (err) {
        // 桥接服务没开时不刷屏，只在控制台留一句
        console.debug("[AVATAR-Bridge] 无法连接桥接服务（正常运行 python st_avatar_bridge.py）", err.message ?? err);
    }
}

// 角色消息生成完成（非流式主通道）
eventSource.on(event_types.MESSAGE_RECEIVED, (messageId) => pushToBridge(messageId));
// 渲染完成（流式输出结束后也会触发）
eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (messageId) => pushToBridge(messageId));

// 诊断：打印当前执行环境，判断扩展跑在本地浏览器还是云端
console.log("[AVATAR-Bridge] 扩展已加载 → http://127.0.0.1:8799/event");
console.log("[AVATAR-Bridge] 执行环境诊断: location.origin =", window.location.origin, "| 是否为本地:", window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost");

// 桥接可达性自检（异步，不影响主流程）
try {
    fetch("http://127.0.0.1:8799/ping")
        .then(r => r.json())
        .then(d => console.log("[AVATAR-Bridge] ✅ 本地桥接可达:", d))
        .catch(e => console.log("[AVATAR-Bridge] ❌ 本地桥接不可达（若在非本机打开云酒馆则正常）:", e.message));
} catch (e) { /* 忽略 */ }

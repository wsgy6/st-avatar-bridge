// SillyTavern → AVATAR 桥接扩展（方案A：流式逐句驱动，v3 加固版）
// 目标：云酒馆角色回复【流式逐字】输出时，让桌面 AVATAR 实时跟动作。
//
// 本版修复实测暴露的三类问题：
//   1) 同一句被刷几十次（日志里「你是穿越者啊。」刷屏）
//      → 前缀差分去重 + 整句指纹去重，增量式/累积式 token 都各只发一次。
//   2) HTML 注释草稿(<!-- 模拟段落/草稿优化:… -->)泄漏进正文
//      → 对“已累积的整段原文”做一次正则剥离，天然免疫 <!--/--> 被切碎跨 token。
//   3) “后面的剧情没分析到”
//      → 结尾 GENERATION_ENDED 用 ctx.chat 完成的整条消息全量对账(sentSig 去重)。
//
// 剥离策略说明（为什么不用逐步状态机）：
//   `<!--` / `-->` 可能被切成 `<`、`!`、`-`… 逐个到达，若按 chunk 增量判会漏/卡死。
//   改为：累积原始文本 rawAcc → 每次 ingest 全量算一次可见文本 → 与上次比对，
//   只把“新出现的完整句”发出去。消息也就 ~2KB，全量重算代价可忽略。
//
// v3.1：除 HTML 注释外，还整块剥除“非剧情结构标签”
//   `<parallel_world>…</parallel_world>`、`<UpdateVariable>…</UpdateVariable>` 等
//   （角色卡/模型用它放平行世界群消息、记忆/状态变量，不是当前剧情动作台词，
//    不喂给 Qwen，避免浪费分析 + 误触发无关动作）。可扩充 STRIP_BLOCK_TAGS。
//   整段正则 → 天然免疫 <tag 或 </tag> 被切碎跨 token。
//
// 兼容：零 import，全局 SillyTavern.getContext()

const BRIDGE_URL = "http://127.0.0.1:8799/analyze";

// 要整块从可见正文里剥掉的“非剧情结构标签”。按闭合形态分两类，避免误删剧情：
//   tail   : 成对长块 <tag>…</tag>（值可能很长、通常在消息尾部），剥整块；流式中途
//            标签已开未闭时，先将其后内容不视为可见（防 parallel_world 内部被当剧情发）。
//   inline : 自闭合 / 单标签 <tag …/>、<tag …>（如变量注入，无内容体），剥标签自身、
//            或成对则剥整块；但【不做】“未闭合切尾”——避免把标签后的真剧情误删。
// 新增同类标签时：确认它是成对长块(tail)还是短标签(inline)再登记。
const STRIP_BLOCK_TAGS = { parallel_world: "tail", UpdateVariable: "inline" };

let rawAcc = "";       // 本次生成累积的原始文本（含注释）
let rawLast = "";      // 最近一次收到的原始文本（前缀差分去重用）
let visLen = 0;        // 已消费的可见文本长度（只发其后的新句子）
let genActive = false;
let busy = false;
let dbgCount = 0;      // 打印前几个 token 形态，便于核对事件载荷

const SENT_END = /[。！？!?\n…]/;
const JUNK_ONLY = /^[\s#*·\-—…。，、；：“”「」『』（）()!?！？：:,.。\s]*$/;

// ---- 取 token 文本（兼容 string / {text} / {delta:{content}} / {content}）----
function tokText(tok) {
    if (typeof tok === "string") return tok;
    if (tok == null) return "";
    return String(tok.text ?? tok.delta?.content ?? tok.content ?? "");
}

// ---- 对“整段累积原文”剥离 HTML 注释 + 非剧情结构标签，返回纯可见文本 ----
// ① HTML 注释 <!--…-->：若末尾有尚未闭合的 <!--，其后内容暂不视为可见（等闭合后下一次纠正）。
// ② 非剧情结构标签（STRIP_BLOCK_TAGS）：tail → 剥成对整块；inline → 剥成对整块或自闭合单标签。
// ③ 顺序：先剥注释（可能把 `<tag` 夹在注释里的情况先清掉），再剥结构标签。
function stripCommentsFull(raw) {
    let s = String(raw ?? "").replace(/<!--[\s\S]*?-->/g, "");
    const lastOpen = s.lastIndexOf("<!--");
    if (lastOpen >= 0) s = s.slice(0, lastOpen);   // 剥掉残留未闭合注释
    for (const [t, mode] of Object.entries(STRIP_BLOCK_TAGS)) {
        // 1) 若有闭合标签 → 成对整块剥（tail 与 inline 都支持成对形态）
        s = s.replace(new RegExp("<" + t + "\\b[\\s\\S]*?</" + t + "\\s*>", "gi"), "");
        if (mode === "tail") {
            // 2a) tail：成对长块，流式中途标签已开未闭 → 其后内容先不算可见（闭合后下次补剥）
            const lo = s.toLowerCase().lastIndexOf("<" + t.toLowerCase());
            if (lo >= 0) s = s.slice(0, lo);
        } else {
            // 2b) inline：剥“自闭合/无闭合的单标签”自身，保留 `>` 后的剧情（绝不切尾）
            s = s.replace(new RegExp("<" + t + "\\b[^>]*/?>", "gi"), "");
        }
    }
    return s;
}

// ---- 主入口：把新增 token 并入，剥注释，只发“新出现的完整句” ----
function ingestRaw(raw) {
    const s = String(raw ?? "");
    if (dbgCount < 4) {
        console.log("[AVATAR-Bridge][dbg] tok:", typeof raw, JSON.stringify(s.slice(0, 60)));
        dbgCount++;
    }
    if (!s) return;
    // 前缀差分去重：累积式只取新尾巴；增量式原样追加
    if (rawLast !== "" && s.length > rawLast.length && s.startsWith(rawLast)) {
        rawAcc += s.slice(rawLast.length);
    } else if (rawLast === "" || !s.startsWith(rawLast)) {
        rawAcc += s;
    }
    rawLast = s;
    drainNewSentences();
}

// ---- 把可见文本里“新出现的完整句”收进 outbox，交给 pump 按节拍发送 ----
// visLen 只前移“已收进 outbox”的句子，不因 busy 丢句。
function drainNewSentences() {
    if (!genActive) return;
    const vis = stripCommentsFull(rawAcc);
    if (vis.length <= visLen) return;
    let from = visLen;
    for (let i = from; i < vis.length; i++) {
        if (SENT_END.test(vis[i])) {
            const sent = vis.slice(from, i + 1);
            from = i + 1;
            enqueueSentence(sent);
        }
    }
    visLen = from;            // 全部已入 outbox，安全前移
    pump();
}

let outbox = "";             // 待发句子（Qwen 忙时累积，空闲时合并成一次发送）
const sentSig = new Set();   // 已入队的句子指纹，防重复

// ---- 一句话是否值得分析（滤掉标题/纯标点/太短/正文壳）----
function isMeaningful(s) {
    const c = (s || "").trim();
    if (!c) return false;
    if (c.length < 4) return false;
    if (JUNK_ONLY.test(c)) return false;
    const core = c.replace(/^#{1,6}\s*/, "").trim();
    if (!core) return false;
    if (/^(正文|草稿|模拟段落|草稿优化|内容|场景)[：:\s]*$/.test(core)) return false;
    if (!/[\u4e00-\u9fa5a-zA-Z]/.test(core)) return false;
    return true;
}

function enqueueSentence(s) {
    const c = (s || "").trim();
    if (!isMeaningful(c)) return;
    const clean = c.replace(/\s+/g, " ");
    if (sentSig.has(clean)) return;     // 整句去重（reconcile 重扫不会重发）
    sentSig.add(clean);
    outbox += clean + "\n";             // 换行作自然分隔，Qwen 也读得懂连续剧情
}

// ---- 发送泵：每空闲一次只发一批（忙时合并多句→更省、上下文更全）。
//      单批限制 MAX_BATCH 字，超出按“整句”拆批，避免一次喂太多让 Qwen 400。
const MAX_BATCH = 300;

function pump() {
    if (busy) return;
    if (!outbox.trim()) return;
    const lines = outbox.split("\n").filter(x => x.trim());
    outbox = "";
    // 取尽量多、但累计 ≤ MAX_BATCH 的整句作为本批
    let batch = "";
    const rest = [];
    for (const ln of lines) {
        if (!batch) { batch = ln; continue; }
        if ((batch.length + ln.length + 1) <= MAX_BATCH) { batch += "\n" + ln; continue; }
        rest.push(ln);                       // 太长，留给下一批
    }
    if (rest.length) outbox = rest.join("\n");
    busy = true;
    console.log("[AVATAR-Bridge] 分析:", batch.replace(/\n/g, " ").slice(0, 80));
    post({ message: batch }).then(() => { busy = false; pump(); })
        .catch(() => { busy = false; pump(); });
}

function post(payload) {
    return fetch(BRIDGE_URL, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload) }).then(r => r.json()).catch(() => ({ results: [] }));
}

// ---- 收尾对账：把整条可见文本切成句入队（指纹去重保证不重发）----
function reconcileAll(visibleText) {
    if (!visibleText) return;
    let from = 0;
    for (let i = 0; i < visibleText.length; i++) {
        if (SENT_END.test(visibleText[i])) {
            enqueueSentence(visibleText.slice(from, i + 1));
            from = i + 1;
        }
    }
    const tail = visibleText.slice(from).trim();
    if (tail) enqueueSentence(tail);
    pump();
}

function getCtx() {
    const root = window.SillyTavern || window.sillytavern;
    return root && typeof root.getContext === "function" ? root.getContext() : null;
}

function setup() {
    const ctx = getCtx();
    if (!ctx) { setTimeout(setup, 800); return; }
    const et = ctx.eventTypes || ctx.event_types || {};
    const evt = ctx.eventSource;
    if (!evt || !evt.on) { console.error("[AVATAR-Bridge] 无 eventSource"); return; }

    const startGen = () => { genActive = true; rawAcc = ""; rawLast = ""; visLen = 0; outbox = ""; busy = false; };
    const endGen = () => {
        genActive = false;
        // 兜底1：把残余未消费可见文本（含无句号的末句）整体补发
        const vis = stripCommentsFull(rawAcc);
        if (vis.slice(visLen).trim()) reconcileAll(vis.slice(visLen));
        // 兜底2：用 ctx.chat 已完成消息做全量对账，保证后半段不漏
        const arr = ctx.chat || [];
        const last = arr[arr.length - 1];
        const rawMsg = last ? (last.mes ?? last.message ?? "") : "";
        if (rawMsg) reconcileAll(stripCommentsFull(rawMsg));
        rawAcc = ""; rawLast = ""; visLen = 0; outbox = ""; busy = false;
    };

    if (et.GENERATION_STARTED) evt.on(et.GENERATION_STARTED, startGen);
    if (et.GENERATION_ENDED) evt.on(et.GENERATION_ENDED, endGen);
    if (et.GENERATION_STOPPED) evt.on(et.GENERATION_STOPPED, endGen);

    const tokenEvt = et.STREAM_TOKEN_RECEIVED;
    if (tokenEvt) {
        evt.on(tokenEvt, (tok) => {
            if (!genActive) genActive = true;
            const t = tokText(tok);
            if (t) ingestRaw(t);
        });
        console.log("[AVATAR-Bridge] 已监听流式 token（v3 整段剥注释+去重+兜底对账）");
    } else {
        console.log("[AVATAR-Bridge] 无流式事件 → 消息完成模式");
        const recv = et.MESSAGE_RECEIVED;
        if (recv) evt.on(recv, () => {
            const arr = ctx.chat || [];
            const last = arr[arr.length - 1];
            const rawMsg = last ? (last.mes ?? last.message ?? "") : "";
            if (rawMsg) reconcileAll(stripCommentsFull(rawMsg));
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

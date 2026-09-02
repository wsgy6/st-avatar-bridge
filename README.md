# AVATAR Bridge — SillyTavern 扩展

让 SillyTavern（含云酒馆托管版）的角色回复，实时驱动你电脑桌面上的 **AVATAR** 3D 角色做动作/表情。

## 原理

```
角色回复文本 + 情绪标签
      │  (本扩展监听消息事件)
      ▼
 桥接服务 http://127.0.0.1:8799   (在你电脑上跑 python)
      │  (解析 *动作* / 情绪 → 映射成动画)
      ▼
 AVATAR 本地总线 http://127.0.0.1:47903
      │  animation.play / avatar.set
      ▼
 桌面角色 实时演出
```

## 安装（云酒馆 / 托管版）

1. 你的**电脑**上先跑起桥接服务（见下方"桥接服务"）
2. 云酒馆 → 扩展/Extensions → 从 Git 仓库安装，填本仓库地址
   `https://github.com/wsgy6/st-avatar-bridge`
3. 刷新，控制台出现 `[AVATAR-Bridge] 扩展已加载` 即成功

> 前提：云酒馆在你的**电脑浏览器**里打开（这样 `127.0.0.1` 才指向你电脑）。
> 如果在手机等别处打开，连不到本地，需另配隧道。

## 桥接服务（电脑端，必跑）

桥接是一个本地 Python 服务，需在电脑上独立窗口运行：

```bash
cd /d "E:\virtuat character\bridge"
python st_avatar_bridge.py
```

看到 `ST→AVATAR 桥接已启动: http://127.0.0.1:8799/event` 即成功，保持窗口开着。

## 需要准备的电脑端文件

桥接依赖两个文件（都在 `E:\virtuat character\bridge\`）：
- `token.txt` — AVATAR 的 local bus token（在 AVATAR 设置 → Agents 里复制）
- `mapping.json` — 动作/情绪/服装 → 动画 的映射表

这两个**不需要**也不应该上传 GitHub（含你的 token 和配置），只留在你电脑上。

## 本扩展文件说明

| 文件 | 作用 |
|---|---|
| `manifest.json` | 插件清单，SillyTavern 识别用 |
| `index.js` | 监听角色消息事件 → POST 到本地桥接 |
| `style.css` | 界面样式（当前无 UI，占位） |

## 自定义

编辑 `mapping.json`（电脑端）即可调整映射，**改完保存即生效**，桥接无需重启。

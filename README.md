# AVATAR Bridge — SillyTavern 扩展

让 SillyTavern（含云酒馆托管版）的角色回复，实时驱动桌面上的 **AVATAR** 3D 角色做动作、表情。

## 工作原理

```
角色回复文本 + 情绪标签
      │  （本扩展监听消息事件）
      ▼
 桥接服务 http://127.0.0.1:8799   （本机运行的 Python 服务）
      │  （解析 *动作* / 情绪 → 映射成动画）
      ▼
 AVATAR 本地总线 http://127.0.0.1:47903
      │  animation.play / avatar.set
      ▼
 桌面角色 实时演出
```

## 安装

1. 先在本机运行桥接服务（见下文「本地桥接服务」）
2. 云酒馆 / SillyTavern → 扩展（Extensions）→ **从 Git 仓库安装**，填入：

   `https://github.com/wsgy6/st-avatar-bridge`

3. 刷新页面，控制台出现 `[AVATAR-Bridge] 扩展已加载` 即成功

> ⚠️ 前提：云酒馆需在**本机浏览器**中打开，扩展的桥接地址 `127.0.0.1:8799` 只对本机有效；在手机等其他设备上打开时无法连接本地服务。

## 本地桥接服务

桥接服务负责把扩展发来的消息转发给 AVATAR 本地总线。在桥接目录运行：

```bash
python st_avatar_bridge.py
```

看到 `ST→AVATAR 桥接已启动: http://127.0.0.1:8799/event` 即成功，保持窗口运行。

桥接依赖两个本地文件（**请勿**提交到任何仓库）：

- `token.txt`：AVATAR 本地总线的访问令牌
- `mapping.json`：动作 / 情绪 / 服装 → 动画 的映射表

## 扩展文件说明

| 文件 | 作用 |
|---|---|
| `manifest.json` | 插件清单，SillyTavern 识别用 |
| `index.js` | 监听角色消息事件 → POST 到本地桥接 |
| `style.css` | 界面样式（当前无 UI，占位） |

## 自定义

编辑 `mapping.json` 即可调整映射，保存后即时生效，桥接无需重启。

## 隐私说明

- 本扩展仅将角色回复文本 POST 到本机 `127.0.0.1:8799`，**不包含**任何 token、账号或个人信息
- `token.txt` / `mapping.json` 属于本机私有配置，请勿提交到任何公开仓库

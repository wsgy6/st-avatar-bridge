# AVATAR Bridge — SillyTavern 扩展

让 SillyTavern（含云酒馆托管版）的角色回复，实时驱动桌面上的 **AVATAR** 3D 角色做动作、表情。

## 装哪里（重点，先看这个）

| 东西 | 装在哪 | 怎么装 |
|---|---|---|
| 扩展 | 云酒馆的扩展列表里 | 云酒馆 → 扩展 → 从 Git 仓库安装 → 填 `https://github.com/wsgy6/st-avatar-bridge` |
| 桥接服务 | **你自己的电脑**上 | 下载本仓库 `bridge/` 文件夹，运行 `python st_avatar_bridge.py` |
| token.txt / mapping.json | 电脑上，和桥接服务放一起 | 自己创建，**绝对不要**上传到任何仓库 |

> ⚠️ 桥接服务是跑在你自己电脑上的程序，**不是扩展**，不要把它装进云酒馆！

## 工作原理

```
角色回复文本 + 情绪标签
      │  （扩展监听消息事件）
      ▼
 桥接服务 http://127.0.0.1:8799   （电脑上运行）
      │  （解析动作/情绪 → 映射成动画）
      ▼
 AVATAR 本地总线 http://127.0.0.1:47903
      ▼
 桌面角色 实时演出
```

## 安装步骤

1. **电脑上**：下载 `bridge/`，把 `mapping.example.json` 复制成 `mapping.json`，创建 `token.txt`（AVATAR 本地总线 token），然后运行 `python st_avatar_bridge.py`，看到 `ST→AVATAR 桥接已启动` 即成功
2. **云酒馆**：扩展 → 从 Git 仓库安装 → 填 `https://github.com/wsgy6/st-avatar-bridge`
3. 刷新页面，控制台出现 `[AVATAR-Bridge] 扩展已加载`，再看到 `✅ 本地桥接可达` 就完成了

> ⚠️ 云酒馆需在**本机浏览器**中打开，`127.0.0.1` 才指向你的电脑；手机等设备上打开连不到本地服务。

## 文件说明

| 文件 | 位置 | 作用 |
|---|---|---|
| `manifest.json` `index.js` `style.css` | 仓库根 | 扩展本体（装进云酒馆） |
| `bridge/st_avatar_bridge.py` | 仓库 bridge/ | 桥接服务（跑在你电脑上） |
| `bridge/mapping.example.json` | 仓库 bridge/ | 映射表示例，复制为 mapping.json 使用 |
| `token.txt` | 不提供 | 你自己的 AVATAR 总线 token，请勿上传 |

## 隐私说明

- 扩展只把角色回复文本 POST 到本机 `127.0.0.1:8799`，不包含任何 token、账号或个人信息
- `token.txt` / `mapping.json` 是本地私有配置，请勿提交到任何公开仓库

## License

MIT

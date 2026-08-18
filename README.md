# 手机工作媒介 · 使用与部署说明

一个手机网页版工作媒介，对接 DeepSeek Harness 智能体。可查看近期对话、下载工作成果、上传文件、与智能体对话、切换模型，支持多风格界面。

## 目录结构

```
手机工作媒介/
├── mobile/            # 手机 PWA 前端（纯静态，多主题）
│   ├── index.html
│   ├── styles.css
│   ├── app.js
│   └── manifest.webmanifest
├── bridge/            # Node 桥接服务（零第三方依赖）
│   └── server.mjs
├── deploy/            # 部署脚本与 systemd 单元
│   ├── start.sh
│   └── workbench.service
└── 工作计划.md
```

## 快速启动（本机测试）

```bash
cd bridge
node server.mjs
# 或
bash ../deploy/start.sh
```

打开 http://127.0.0.1:8090 即可（手机浏览器可"添加到主屏幕"作为 App 使用）。

## 配置（环境变量，均带 WORKBENCH_ 前缀）

| 变量 | 默认 | 说明 |
|------|------|------|
| WORKBENCH_PORT | 8090 | 桥接监听端口 |
| WORKBENCH_HOST | 127.0.0.1 | 监听地址；内外网设 0.0.0.0 |
| WORKBENCH_DSH_BASE | http://127.0.0.1:3080 | DSH web 服务地址 |
| WORKBENCH_WORK_DIRS | 上级目录 | 冒号分隔的文件根目录 |
| WORKBENCH_ACCESS_TOKEN | 空 | 可选访问口令（暴露公网建议设置） |

## 界面风格（4 套，右上角或设置里切换）

- **云岫·钉钉风**（默认）：浅色气泡、圆角、拟钉钉聊天
- **Hermes·深色**：深色控制台、科技蓝
- **水墨·松岭风**：宣纸浅米、水墨点缀
- **极简白**：纯净信息流

## Zerotier 内外网打通（已完成 ✅）

1. 本机安装 zerotier-one 并加入你的 Zerotier 网络。
2. 获取本机 Zerotier 地址（`ip -4 addr show zt*` 或 `zerotier-cli listnetworks`）。
3. 桥接服务监听 0.0.0.0 + 设置访问口令。
4. 手机安装 Zerotier One、加入同一网络并授权后，用以下地址访问：
   `http://<Zerotier地址>:8090/?token=<口令>`
5. 同一 Zerotier 网络内，内外网都用这一个地址。

## 当前运行状态

- 桥接服务：`http://0.0.0.0:8090`（回环 / 局域网 / Zerotier 多路可达）
- 访问口令：见 `deploy/.access_token`（自行保管，可改）

## 开机自启（systemd）

```bash
sudo cp deploy/workbench.service /etc/systemd/system/workbench.service
# 编辑 /etc/systemd/system/workbench.service，改 User/路径/口令
sudo systemctl daemon-reload
sudo systemctl enable --now workbench
```

## 接口一览（供二次开发）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/health | 健康检查 |
| GET | /api/sessions | 近期对话列表 |
| GET | /api/sessions/:id | 某会话历史消息 |
| POST | /api/chat | 发消息，SSE 流式返回 |
| GET | /api/files | 工作成果文件列表 |
| GET | /api/files/download?path= | 下载文件 |
| POST | /api/upload | 上传文件（multipart） |
| GET | /api/models | 模型列表 |
| POST | /api/models/switch | 切换模型 |

## 说明与限制

- 聊天/历史/模型通过 DSH 的 `/api` RPC 对接；文件/上传直接读写本地目录。
- 聊天采用「发送后轮询历史」方式流式回显，消息粒度（非 token 级）刷新，体验略粗但更稳定。
- 桥接服务与 DSH web 需在同一台机器（DSH 默认只监听 127.0.0.1）。
- DSH 官方对"远程无鉴权访问"持保留态度；Zerotier 是私有虚拟局域网，加上口令后风险可控。

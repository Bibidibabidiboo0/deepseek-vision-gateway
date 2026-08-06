# deepseek-vision-gateway

给 DeepSeek 驱动的 Claude Code 补上**免费识图能力**：零依赖、单文件、纯 Node（≥18）本地网关。

```
Claude Code ──► http://127.0.0.1:8787 (本网关)
                  ├── 最新消息带图 ──► 智谱 GLM-4V-Flash（免费视觉模型）
                  └── 纯文字 ──► DeepSeek /anthropic（原样透传）
```

DeepSeek 没有视觉能力（收到图片只显示 `[Unsupported Image...` 占位符），网关把"最新一条消息带图"的请求转成 OpenAI 格式发给智谱免费视觉模型 GLM-4V-Flash，识别结果再转回 Anthropic 格式返回。支持 SSE 流式、Read 读图/截图、Anthropic↔OpenAI 双向转换。

## 快速上手（约 3 分钟）

**① 启动网关**

```bash
git clone https://github.com/Cicicrr/deepseek-vision-gateway.git
cd deepseek-vision-gateway
cp .env.example .env    # 填 DEEPSEEK_API_KEY 和 VISION_API_KEY（智谱开放平台免费申请）
./start.sh
curl http://127.0.0.1:8787/health    # 返回 ok 即启动成功
```

**② 把 Claude Code 指向网关**

编辑 `~/.claude/settings.json`，**整个文件内容**替换为：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787",
    "ANTHROPIC_AUTH_TOKEN": "任意占位值",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "deepseek-v4-flash",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "deepseek-v4-flash[1M]",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "deepseek-v4-flash[1M]",
    "ANTHROPIC_MODEL": "deepseek-v4-flash[1M]"
  }
}
```

模型名随便填——网关只做路由，真正干活的是 DeepSeek（文字）和 GLM-4V-Flash（视觉）。

**③ 重启 Claude Code，发一张图问"这是啥"** ✅

## 常见问题

| 现象 | 解决 |
|---|---|
| `Error in the HTTP2 framing layer` | macOS git 已知毛病：`git config --global http.version HTTP/1.1` 后重试 |
| 改了网关代码不生效 | 网关由 launchd 托管（KeepAlive），杀掉会被秒拉起。必须 `launchctl kickstart -k gui/$(id -u)/com.llm.gateway`，单独 `./stop.sh` 没用 |
| 图认错了 / 被追问时编造 | 免费档 glm-4v-flash 的正常水平：**大类稳、小类看运气**。要求高就换付费 `glm-4v-plus` |
| 发图后纯文字追问说"看不到图" | 正常——文字请求走 DeepSeek，它看不到历史图片，**要它看图必须重新附图** |

## 可选：vision 技能（一键安装）

让 Claude 自动懂这套识图机制（触发词：识图、看图片、图片识别等）。注意：**技能只是说明书，看图仍靠网关**，两步都要做。

```bash
claude plugin marketplace add https://github.com/Cicicrr/deepseek-vision-gateway
claude plugin install deepseek-vision-gateway@deepseek-vision-gateway
```

重启 Claude 会话后生效。手动装也行：`mkdir -p ~/.claude/skills/vision && cp .claude/skills/vision/SKILL.md ~/.claude/skills/vision/`

## 路由规则

| 请求内容 | 路由 |
|---|---|
| 最新一条消息带图（新发图片 / 工具返回的图片） | → GLM-4V-Flash |
| 纯文字（历史里有图也算纯文字请求） | → DeepSeek |

## 配置（.env）

| 键 | 说明 |
|---|---|
| `PORT` | 监听端口（默认 8787） |
| `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` | 文本透传目标（DeepSeek Anthropic 兼容端点） |
| `VISION_API_KEY` / `VISION_BASE_URL` | 智谱 key（`open.bigmodel.cn`，glm-4v-flash 免费） |
| `VISION_MODEL` | 默认 `glm-4v-flash`；可换付费的 `glm-4v-plus` 提升识别力 |
| `VISION_MODE` | `glm`（当前）；`mineru`（本地 OCR 路由，待实现） |
| `MAX_KEEP_TURNS` / `MAX_CTX_CHARS` | 发给 GLM 的历史裁剪（glm-4v-flash 上下文小） |

## 更多

- **免费生图**：`./gen-image.sh "提示词" [输出路径]` — 同一把智谱 key 调 cogview-3-flash，结果转 PNG 并打开。
- **开机自启**：写 launchd plist（见 git 历史 / 仓库旧版 README），⚠️ KeepAlive 下重启必须用上面的 `launchctl kickstart -k`。

## 已知限制

- 免费档 glm-4v-flash：大类稳、小类看运气、被追问会编（示例：米菲兔认成"兔子"，逼问下胡诌成"丁丁"）。
- glm-4v-flash 输出上限 1024 tokens（Claude Code 会发 32000+，网关负责钳制）；免费档限流约 100 RPM。
- 带图请求会整段对话（裁剪后最近 8 轮）发给智谱 → **图片会离开本机**；纯文字请求只发 DeepSeek。
- GLM-4V-Flash 不支持 tool 角色消息：网关把工具结果（含图片）扁平化成 user 内容（已验证 Read 读图场景）。

## License

MIT

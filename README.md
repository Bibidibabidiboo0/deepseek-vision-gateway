# deepseek-vision-gateway

给 DeepSeek 驱动的 Claude Code 补上**免费识图能力**的本地网关：零依赖、单文件、纯 Node（≥18）。

```
Claude Code ──► http://127.0.0.1:8787 (本网关)
                  ├── 最新消息带图 ──► 智谱 GLM-4V-Flash（免费视觉模型）
                  └── 纯文字 ──► DeepSeek /anthropic（原样透传）
```

- **DeepSeek 没有视觉能力**（收到图片只显示 `[Unsupported Image...` 占位符），所以网关把"最新一条消息带图"的请求转成 OpenAI 格式发给智谱的免费视觉模型 GLM-4V-Flash，识别结果再转回 Anthropic 格式返回。
- **历史里的旧图不触发视觉路由**——发过图后纯文字聊天仍走 DeepSeek，不会整段对话被 GLM 接管（否则问"你是谁"会得到"我是ChatGLM"）。
- 支持 SSE 流式、工具调用（Read 读图/截图）、Anthropic↔OpenAI 双向转换、上下文裁剪（glm-4v-flash 上下文小）。

## 快速开始

```bash
git clone https://github.com/Cicicrr/deepseek-vision-gateway.git
cd deepseek-vision-gateway
cp .env.example .env        # 填 DEEPSEEK_API_KEY 和 VISION_API_KEY（智谱开放平台免费申请）
./start.sh                  # 后台启动，curl http://127.0.0.1:8787/health 检查
```

把 Claude Code 指向网关（`~/.claude/settings.json`）：

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

模型名可以随便填——网关只做路由，真正干活的是 DeepSeek（文字）和 GLM-4V-Flash（视觉）。重启 Claude Code 后生效。

## 配置（.env）

| 键 | 说明 |
|---|---|
| `PORT` | 监听端口（默认 8787） |
| `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` | 文本透传目标（DeepSeek Anthropic 兼容端点） |
| `VISION_API_KEY` / `VISION_BASE_URL` | 智谱 key（`open.bigmodel.cn`，glm-4v-flash 免费） |
| `VISION_MODEL` | 默认 `glm-4v-flash`；可换付费的 `glm-4v-plus` 提升识别力 |
| `VISION_MODE` | `glm`（当前）；`mineru`（本地 OCR 路由，待实现） |
| `MAX_KEEP_TURNS` / `MAX_CTX_CHARS` | 发给 GLM 的历史裁剪（glm-4v-flash 上下文小） |

## 路由规则

| 请求内容 | 路由 |
|---|---|
| 最新一条消息带图（新发图片 / 工具返回的图片） | → GLM-4V-Flash |
| 纯文字（历史里有图也算纯文字请求） | → DeepSeek |

⚠️ 发图后的**纯文字追问**会走 DeepSeek——它看不到历史图片，需要看图请重新附图。

## 附带：免费生图

`./gen-image.sh "提示词" [输出路径]` — 用同一把智谱 key 调 cogview-3-flash 免费生图，结果转 PNG 并打开。

## 已知限制

- 免费档 glm-4v-flash：**大类稳、小类看运气、被追问会编**（示例：米菲兔被认成"兔子"，逼问下胡诌成"丁丁"）。对识别质量要求高请换付费 `glm-4v-plus`。
- glm-4v-flash 输出上限 1024 tokens（Claude Code 会发 32000+，网关负责钳制）；免费档限流约 100 RPM。
- 带图请求会整段对话（裁剪后最近 8 轮）发给智谱 → **图片会离开本机**；纯文字请求只发 DeepSeek。
- GLM-4V-Flash 不支持 tool 角色消息：网关会把工具结果（含图片）扁平化成 user 内容（已验证 Read 工具读图场景）。

## 开机自启（可选）

把仓库克隆目录和启动命令写进 launchd（`~/Library/LaunchAgents/com.llm.gateway.plist`）：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key><string>com.llm.gateway</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/env</string><string>bash</string><string>启动脚本绝对路径/start.sh</string>
  </array>
  <key>WorkingDirectory</key><string>仓库绝对路径</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>仓库绝对路径/gateway.log</string>
  <key>StandardErrorPath</key><string>仓库绝对路径/gateway.log</string>
</dict>
</plist>
```

> ⚠️ 注意：`KeepAlive=true` 下杀掉进程会被 launchd 秒拉起。**改完代码重启必须用 `launchctl kickstart -k gui/$(id -u)/com.llm.gateway`**，单独 `./stop.sh` 会把旧实例拉起、新代码不生效。

## Claude Code 技能

仓库内附带 `skills/vision/SKILL.md`——把识图路由机制、运维要点、能力边界打包成 Claude Code 技能：

```bash
mkdir -p ~/.claude/skills/vision
cp skills/vision/SKILL.md ~/.claude/skills/vision/SKILL.md
```

重启 Claude 会话后，遇到识图相关任务会自动加载（触发词：识图、看图片、图片识别等）。

## License

MIT

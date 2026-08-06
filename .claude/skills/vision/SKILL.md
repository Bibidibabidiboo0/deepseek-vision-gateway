---
name: vision
description: Claude Code 免费识图能力的机制与运维说明（DeepSeek 文本 + 智谱 GLM-4V-Flash 免费视觉的路由网关）。触发词：识图、看图片、图片识别、这是啥、看图、识别图片、图片里是什么、为什么看不到图。
---

# 识图（DeepSeek + 智谱 GLM-4V-Flash 免费视觉）

## 一句话架构

```
Claude Code ──► 本地网关 127.0.0.1:8787（gateway.mjs，零依赖）
                  ├── 最新消息带图 → 智谱 GLM-4V-Flash（免费视觉模型）
                  └── 纯文字 → DeepSeek /anthropic 端点（原样透传）
```

看图靠的是**智谱免费模型**，不是 DeepSeek 也不是 Claude 本体。

## 路由规则（2026-08-05 起）

- **只看"最新一条消息"是否带图**：新发图片、或工具结果（Read/截图）返回的图片 → 走 GLM
- **历史里的旧图不触发**：一旦发过图，整段对话并不会被路由给 GLM
- 发图后的**纯文字追问**（不重新附图）→ 走 DeepSeek

## 关键坑（已验证）

1. **DeepSeek 看不到历史图片**：收到图片只显示 `[Unsupported Image...` 占位符，不报错但看不到内容。所以"发图后文字追问"它只会说"我看不到图"——**要它看图必须重新附图**。
2. **LaunchAgent KeepAlive 坑**：网关由 launchd 托管（`KeepAlive=true`），杀掉进程会被**秒拉起**。改完代码必须：
   ```bash
   launchctl kickstart -k gui/$(id -u)/com.llm.gateway
   ```
   单独 `./stop.sh` 没用——旧实例被拉起，新代码不生效（曾因此出现"改了不生效"的假象）。
3. **免费档 glm-4v-flash 能力边界**：大类稳（能认出"兔子"）、小类看运气（米菲认成"兔子"）、**被追问会编**（逼问下把米菲胡诌成"丁丁"，细节也编错）。认不出时它倾向于给保守回答或编造，别全信。
4. **输出上限**：glm-4v-flash 的 max_tokens 被钳制在 1024；免费档限流约 100 RPM，超限报错。
5. **身份串台**：整段对话路由给 GLM 时，问"你是谁"会答"我是ChatGLM"——这正是第 2 条路由规则存在的原因。

## 运维

```bash
curl http://127.0.0.1:8787/health        # 状态检查（vision_model / key 是否配置）
tail -f gateway.log                       # 日志里 route=vision / route=deepseek 能看出走的谁
./start.sh                                # 启动
```

## 排障

- 发图没走 GLM？查日志 `route=` 字段：最新消息必须真带图（工具返回的图也算）
- 识图质量差？免费档就这样；换 `VISION_MODEL=glm-4v-plus`（付费）可提升
- 改代码不生效？先 `launchctl kickstart -k` 再看日志时间戳

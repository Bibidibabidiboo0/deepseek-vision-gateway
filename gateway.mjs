#!/usr/bin/env node
/**
 * llm-gateway — 本地 LLM 网关（零依赖，Node >= 18）
 *
 * 实现 Anthropic Messages API（Claude Code 的 ANTHROPIC_BASE_URL 协议）：
 *   - 最新消息无图 → 原样透传 DeepSeek 的 /anthropic 兼容端点
 *   - 最新消息带图 → Anthropic↔OpenAI 双向转换，路由到 GLM-4V-Flash（智谱，免费视觉模型）
 *     （只看“最新一条消息”是否带图；历史里的旧图不触发视觉路由）
 *   - 支持流式 SSE（含 OpenAI 流 → Anthropic SSE 转换）、工具调用转换、
 *     上下文裁剪（glm-4v-flash 上下文小）、count_tokens 兜底估算
 *
 * 配置见同目录 .env（或环境变量）。
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------- 配置 ----------------
function loadEnv() {
  const path = join(__dirname, '.env');
  if (existsSync(path)) {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  }
}
loadEnv();

const PORT = +(process.env.PORT || 8787);
const DEEPSEEK_BASE = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/anthropic').replace(/\/+$/, '');
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || '';
const VISION_BASE = (process.env.VISION_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4').replace(/\/+$/, '');
const VISION_KEY = process.env.VISION_API_KEY || '';
const VISION_MODEL = process.env.VISION_MODEL || 'glm-4v-flash';
const VISION_MODE = process.env.VISION_MODE || 'glm'; // glm | mineru（mineru 待实现）
const VISION_MAX_TOKENS = 1024; // glm-4v-flash 硬上限（官方限制 [1,1024]，Claude Code 会发 32000+）
const MAX_KEEP_TURNS = +(process.env.MAX_KEEP_TURNS || 8);
const MAX_CTX_CHARS = +(process.env.MAX_CTX_CHARS || 16000); // 估算 ~5-6k tokens

const SHORT_SYSTEM =
  '你是 Claude Code 的视觉模块。用户需要你理解图片并回答。请仔细看图，' +
  '必要时可调用提供的工具（如 Read/Bash）。回复使用与用户提问相同的语言。';

function log(...a) { console.log(new Date().toISOString(), '[gateway]', ...a); }

// ---------------- 图片检测 ----------------
function blockHasImage(b) {
  if (!b) return false;
  if (b.type === 'image') return true;
  if (b.type === 'tool_result' && Array.isArray(b.content)) {
    return b.content.some(blockHasImage);
  }
  return false;
}
// 路由判定：只看“最新一条消息”（本次要答的内容）是否带图。
// 历史消息里的旧图不算 —— 否则一旦发过图，整段对话都会被路由给 GLM。
// 覆盖两种新图：用户新发的图片，以及工具结果（如 Read/截图）返回的图片。
function latestMessageHasImage(body) {
  if (!Array.isArray(body.messages) || body.messages.length === 0) return false;
  const last = body.messages[body.messages.length - 1];
  return Array.isArray(last.content) && last.content.some(blockHasImage);
}
function countImages(body) {
  let n = 0;
  for (const m of body.messages || []) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type === 'image') n++;
      else if (b.type === 'tool_result' && Array.isArray(b.content)) {
        for (const bb of b.content) if (bb && bb.type === 'image') n++;
      }
    }
  }
  return n;
}

// ---------------- 上下文裁剪（在 Anthropic 空间、按回合边界裁） ----------------
function trimTurns(messages) {
  let kept = messages.length > MAX_KEEP_TURNS ? messages.slice(-MAX_KEEP_TURNS) : messages;
  // 防止开头是孤儿 tool_result（丢了配对的 assistant tool_use 会被 OpenAI 格式拒绝）
  let start = 0;
  while (start < kept.length) {
    const m = kept[start];
    const isToolResultMsg =
      m.role === 'user' &&
      Array.isArray(m.content) &&
      m.content.some(b => b && b.type === 'tool_result');
    if (m.role === 'assistant' || !isToolResultMsg) break;
    start++;
  }
  if (start > 0 && start < kept.length) kept = kept.slice(start);
  kept = kept.slice(); // copy
  const est = () => JSON.stringify(kept).length;
  while (est() > MAX_CTX_CHARS && kept.length > 1) {
    const [first, second] = kept;
    const firstHasToolResult =
      Array.isArray(first?.content) && first.content.some(b => b && b.type === 'tool_result');
    const secondIsAssistantWithTools =
      second?.role === 'assistant' &&
      Array.isArray(second?.content) &&
      second.content.some(b => b && b.type === 'tool_use');
    if (firstHasToolResult && secondIsAssistantWithTools) kept.splice(0, 2);
    else kept.shift();
  }
  return kept;
}

// ---------------- Anthropic → OpenAI ----------------
function imagePart(b) {
  const src = b.source || {};
  const media = src.media_type || 'image/png';
  return { type: 'image_url', image_url: { url: `data:${media};base64,${src.data}` } };
}

function anthropicToOpenAI(body) {
  const messages = [];
  messages.push({ role: 'system', content: SHORT_SYSTEM });
  // 连续 user 消息合并（智谱要求更严）
  const push = msg => {
    const last = messages[messages.length - 1];
    if (last && last.role === 'user' && msg.role === 'user') {
      const lc = Array.isArray(last.content) ? last.content : [{ type: 'text', text: last.content }];
      const mc = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content }];
      last.content = [...lc, ...mc];
    } else {
      messages.push(msg);
    }
  };
  for (const m of trimTurns(body.messages || [])) {
    const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }];
    if (m.role === 'user') {
      const parts = [];
      for (const b of blocks) {
        if (b.type === 'text') parts.push({ type: 'text', text: b.text });
        else if (b.type === 'image') parts.push(imagePart(b));
        else if (b.type === 'tool_result') {
          // 智谱 GLM-4V-Flash 不认 tool 角色消息（尤其不能带图）：
          // 把工具结果文本 + 图片扁平化为 user 内容，与相邻 user 消息合并
          const content = Array.isArray(b.content) ? b.content : [{ type: 'text', text: String(b.content ?? '') }];
          const texts = [];
          const imgs = [];
          for (const bb of content) {
            if (bb && bb.type === 'image') imgs.push(imagePart(bb));
            else if (bb && bb.type === 'text') texts.push(bb.text);
          }
          if (texts.length || imgs.length) {
            parts.push({
              type: 'text',
              text: texts.length ? '工具已执行完毕，返回结果如下：' : '工具已执行完毕。以下是工具返回的图片内容：',
            });
          }
          if (texts.length) parts.push({ type: 'text', text: texts.join('\n\n') });
          parts.push(...imgs);
        }
      }
      if (parts.length) push({ role: 'user', content: parts });
    } else if (m.role === 'assistant') {
      const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n');
      const toolCalls = blocks
        .filter(b => b.type === 'tool_use')
        .map(b => ({
          id: b.id,
          type: 'function',
          function: {
            name: b.name,
            arguments: typeof b.input === 'string' ? b.input : JSON.stringify(b.input ?? {}),
          },
        }));
      if (!text && !toolCalls.length) continue; // 只有 thinking 的回合
      const msg = { role: 'assistant', content: text || null };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      push(msg);
    }
  }
  return messages;
}

// ---------------- OpenAI → Anthropic（非流式） ----------------
const FINISH_MAP = { stop: 'end_turn', tool_calls: 'tool_use', length: 'max_tokens', content_filter: 'end_turn' };

function openaiToAnthropic(data, requestedModel) {
  const choice = (data.choices && data.choices[0]) || {};
  const content = [];
  if (choice.message?.content) content.push({ type: 'text', text: choice.message.content });
  for (const tc of choice.message?.tool_calls || []) {
    let input = {};
    try { input = JSON.parse(tc.function.arguments || '{}'); } catch { /* 保持 {} */ }
    content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
  }
  return {
    id: data.id || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: requestedModel,
    content,
    stop_reason: FINISH_MAP[choice.finish_reason] || 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: data.usage?.prompt_tokens || 0,
      output_tokens: data.usage?.completion_tokens || 0,
    },
  };
}

// ---------------- OpenAI 流 → Anthropic SSE ----------------
async function streamOpenAItoAnthropic(upstreamBody, res, requestedModel) {
  const enc = new TextDecoder();
  const reader = upstreamBody.getReader();
  let started = false;
  let textOpen = false;
  const toolBlocks = new Map(); // index -> {id, name, args, started, index}
  let blockCount = 0;
  let stopReason = 'end_turn';
  let outputTokens = 0;
  let buf = '';

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const openText = () => {
    if (textOpen) return;
    send('content_block_start', { type: 'content_block_start', index: blockCount, content_block: { type: 'text', text: '' } });
    textOpen = true;
    blockCount++;
  };
  const closeText = () => {
    if (textOpen) { send('content_block_stop', { type: 'content_block_stop', index: blockCount - 1 }); textOpen = false; }
  };
  const closeTools = () => {
    for (const blk of toolBlocks.values()) {
      if (blk.started) send('content_block_stop', { type: 'content_block_stop', index: blk.index });
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += enc.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const data = t.slice(5).trim();
        if (data === '[DONE]') continue;
        let chunk;
        try { chunk = JSON.parse(data); } catch { continue; }

        if (!started) {
          const u = chunk.usage || {};
          send('message_start', {
            type: 'message_start',
            message: {
              id: chunk.id || `msg_${Date.now()}`,
              type: 'message',
              role: 'assistant',
              model: requestedModel,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: u.prompt_tokens || 0, output_tokens: 0 },
            },
          });
          started = true;
        }

        const choice = chunk.choices && chunk.choices[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        if (delta.content) {
          openText();
          send('content_block_delta', { type: 'content_block_delta', index: blockCount - 1, delta: { type: 'text_delta', text: delta.content } });
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            let blk = toolBlocks.get(tc.index);
            if (!blk) {
              blk = { id: tc.id || '', name: tc.function?.name || '', args: '', started: false, index: -1 };
              toolBlocks.set(tc.index, blk);
            }
            if (tc.id) blk.id = tc.id;
            if (tc.function?.name) blk.name = tc.function.name;
            if (tc.function?.arguments) blk.args += tc.function.arguments;
            if (!blk.started && blk.name && blk.id) {
              closeText();
              send('content_block_start', { type: 'content_block_start', index: blockCount, content_block: { type: 'tool_use', id: blk.id, name: blk.name, input: {} } });
              blk.started = true;
              blk.index = blockCount;
              blockCount++;
            }
            if (blk.started && tc.function?.arguments) {
              send('content_block_delta', { type: 'content_block_delta', index: blk.index, delta: { type: 'input_json_delta', partial_json: tc.function.arguments } });
            }
          }
        }
        if (choice.finish_reason) {
          stopReason = FINISH_MAP[choice.finish_reason] || 'end_turn';
          if (chunk.usage) outputTokens = chunk.usage.completion_tokens || 0;
        }
      }
    }
    // 兜底：流结束了还没拿到 id/name 的 tool_call（罕见）
    for (const blk of toolBlocks.values()) {
      if (!blk.started && (blk.name || blk.id)) {
        closeText();
        send('content_block_start', { type: 'content_block_start', index: blockCount, content_block: { type: 'tool_use', id: blk.id || `toolu_${blockCount}`, name: blk.name || 'unknown', input: {} } });
        blk.started = true;
        blk.index = blockCount;
        blockCount++;
        if (blk.args) send('content_block_delta', { type: 'content_block_delta', index: blk.index, delta: { type: 'input_json_delta', partial_json: blk.args } });
      }
    }
    closeText();
    closeTools();
    if (started) {
      send('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: outputTokens } });
      send('message_stop', { type: 'message_stop' });
    }
  } finally {
    reader.releaseLock();
  }
}

// ---------------- 视觉路由 ----------------
function buildVisionPayload(body, withTools) {
  const payload = {
    model: VISION_MODEL,
    messages: anthropicToOpenAI(body),
    stream: !!body.stream,
    max_tokens: Math.min(body.max_tokens || VISION_MAX_TOKENS, VISION_MAX_TOKENS),
  };
  if (typeof body.temperature === 'number') payload.temperature = body.temperature;
  if (withTools && Array.isArray(body.tools) && body.tools.length) {
    payload.tools = body.tools
      .filter(t => t && t.name)
      .map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description || '', parameters: t.input_schema || {} },
      }));
  }
  return payload;
}

async function callVision(payload) {
  const upstream = await fetch(`${VISION_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${VISION_KEY}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(300_000), // 免费档首 token 可能慢
  });
  return upstream;
}

async function handleVision(req, res, body) {
  if (VISION_MODE !== 'glm') {
    throw Object.assign(new Error(`VISION_MODE=${VISION_MODE} 暂未实现，请改为 glm`), { status: 501, userMsg: true });
  }
  if (!VISION_KEY) {
    throw Object.assign(new Error('VISION_API_KEY 未配置：在 ~/llm-gateway/.env 里填智谱 key 后重启网关'), { status: 502, userMsg: true });
  }

  const attempts = [true, false]; // 先带工具试，400 则去掉工具重试
  let lastErr = null;
  for (const withTools of attempts) {
    const payload = buildVisionPayload(body, withTools);
    try {
      const upstream = await callVision(payload);
      if (!upstream.ok) {
        const errText = await upstream.text();
        lastErr = new Error(`GLM ${upstream.status}: ${errText.slice(0, 400)}`);
        if (upstream.status !== 400) throw lastErr;
        continue; // 400 → 去掉工具重试
      }
      log('vision ok', VISION_MODEL, 'stream', payload.stream, 'tools', (payload.tools || []).length);
      if (payload.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        await streamOpenAItoAnthropic(upstream.body, res, body.model);
        res.end();
      } else {
        const data = await upstream.json();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(openaiToAnthropic(data, body.model)));
      }
      return;
    } catch (e) {
      if (e && e.name === 'TimeoutError') {
        throw Object.assign(new Error('GLM-4V-Flash 响应超时（300s），免费档可能排队'), { status: 504, userMsg: true });
      }
      lastErr = e;
    }
  }
  throw Object.assign(lastErr || new Error('视觉路由失败'), { status: 502, userMsg: true });
}

// ---------------- 透传 DeepSeek ----------------
async function handlePassthrough(req, res, pathname, body) {
  const headers = {
    'content-type': req.headers['content-type'] || 'application/json',
    'x-api-key': DEEPSEEK_KEY,
    'anthropic-version': req.headers['anthropic-version'] || '2023-06-01',
  };
  if (req.headers.accept) headers.accept = req.headers.accept;
  const upstream = await fetch(`${DEEPSEEK_BASE}${pathname}`, {
    method: req.method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(300_000),
  });
  const ct = upstream.headers.get('content-type') || '';
  if (ct.includes('event-stream')) {
    res.writeHead(upstream.status, { 'content-type': ct, 'cache-control': 'no-cache' });
    await new Promise((resolve, reject) => {
      Readable.fromWeb(upstream.body).on('error', reject).pipe(res).on('finish', resolve);
    });
  } else {
    const text = await upstream.text();
    res.writeHead(upstream.status, { 'content-type': ct });
    res.end(text);
  }
}

// ---------------- count_tokens 兜底 ----------------
function estimateTokens(body) {
  const s = JSON.stringify(body || {});
  return Math.ceil(s.length / 3);
}

// ---------------- HTTP 服务 ----------------
const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
    if (pathname === '/health' || pathname === '/') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        vision_mode: VISION_MODE,
        vision_model: VISION_MODEL,
        vision_key: VISION_KEY ? 'configured' : 'MISSING (填 ~/llm-gateway/.env 的 VISION_API_KEY)',
        deepseek: 'configured',
      }));
      return;
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { /* 非法 JSON 交下游 */ }

    if (pathname === '/v1/messages/count_tokens') {
      try {
        await handlePassthrough(req, res, pathname, body);
      } catch (e) {
        // DeepSeek 端点可能不支持 → 本地估算
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: estimateTokens(body), output_tokens: 0 }));
      }
      return;
    }

    if (pathname === '/v1/messages') {
      if (!body) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'request body must be JSON' } })); return; }
      const route = latestMessageHasImage(body) ? 'vision' : 'deepseek';
      log('route=' + route, 'model=' + body.model, 'stream=' + !!body.stream, 'msgs=' + (body.messages || []).length, 'imgs=' + countImages(body));
      if (route === 'vision') await handleVision(req, res, body);
      else await handlePassthrough(req, res, pathname, body);
      return;
    }

    // 其他路径原样转发
    await handlePassthrough(req, res, pathname, body);
  } catch (e) {
    log('ERROR', e.message);
    if (!res.headersSent) {
      res.writeHead(e.status || 502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: e.userMsg ? e.message : `gateway error: ${e.message}` } }));
    } else {
      res.destroy();
    }
  }
});

server.listen(PORT, '127.0.0.1', () => log(`listening on http://127.0.0.1:${PORT} (vision=${VISION_MODE}, key=${VISION_KEY ? 'set' : 'MISSING'})`));

process.on('SIGTERM', () => { log('shutdown'); server.close(() => process.exit(0)); });
process.on('SIGINT', () => { log('shutdown'); server.close(() => process.exit(0)); });

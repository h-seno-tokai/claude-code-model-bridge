#!/usr/bin/env node
// Anthropic Messages API を話す前段プロキシ.
// model 名でプロバイダを決め, OpenAI 互換 API へ相互変換する.
// どのプロバイダにも一致しない model は upstream (api.anthropic.com) へ無改変で中継する.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fs.realpathSync(fileURLToPath(import.meta.url)));

// OpenAI 互換プロバイダ. 上から順に model 名を照合する.
// 追加する場合はこの配列に 1 エントリ足す.
const PROVIDERS = [
  {
    name: "deepseek",
    re: /^deepseek/i,
    chatUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/chat/completions",
    keyEnv: "DEEPSEEK_API_KEY",
    images: "drop", // vision 非対応
  },
  {
    name: "kimi",
    re: /^(kimi|moonshot)/i,
    chatUrl: process.env.KIMI_BASE_URL || "https://api.moonshot.ai/v1/chat/completions",
    keyEnv: "KIMI_API_KEY",
    images: "url", // vision 対応
  },
];

const CFG = {
  port: Number(process.env.BRIDGE_PORT || 8787),
  host: process.env.BRIDGE_HOST || "127.0.0.1",
  upstream: (process.env.BRIDGE_UPSTREAM || "https://api.anthropic.com").replace(/\/$/, ""),
  maxTokens: Number(process.env.BRIDGE_MAX_TOKENS || 65536),
  emitThinking: process.env.BRIDGE_EMIT_THINKING !== "0",
  // finish_reason 無しで上流が終わったらエラーにする (無言の切り詰めを completion と誤認させない)
  strictFinish: process.env.BRIDGE_STRICT_FINISH !== "0",
  logFile: process.env.BRIDGE_LOG || path.join(DIR, "bridge.log"),
  debug: process.env.BRIDGE_DEBUG === "1",
};

function log(line) {
  const s = `${new Date().toISOString()} ${line}\n`;
  try { fs.appendFileSync(CFG.logFile, s); } catch {}
  if (CFG.debug) process.stderr.write(s);
}

function providerFor(model) {
  return PROVIDERS.find((p) => p.re.test(model || "")) || null;
}

// ---------------------------------------------------------------- utilities

function estimateTokens(x) {
  const s = typeof x === "string" ? x : JSON.stringify(x ?? "");
  return Math.max(1, Math.ceil(s.length / 3.5));
}

// Claude Code は文脈長を表す [1m] 等のサフィックスを付けることがある. 上流には渡さない.
function baseModelName(model) {
  return String(model || "").replace(/\[[^\]]*\]\s*$/, "");
}

// OpenAI の function name は ^[A-Za-z0-9_-]{1,64}$ に限られる.
function sanitizeToolName(name, used) {
  let s = String(name).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  if (!s) s = "tool";
  let out = s, i = 2;
  while (used.has(out)) { out = `${s.slice(0, 60)}_${i++}`; }
  used.add(out);
  return out;
}

function buildToolMaps(tools) {
  const used = new Set(), fwd = new Map(), rev = new Map();
  for (const t of tools || []) {
    const san = sanitizeToolName(t.name, used);
    fwd.set(t.name, san);
    rev.set(san, t.name);
  }
  return { fwd, rev };
}

function stripSchema(schema) {
  if (!schema || typeof schema !== "object") return { type: "object", properties: {} };
  const { $schema, ...rest } = schema;
  return rest;
}

function textOfBlocks(blocks) {
  if (typeof blocks === "string") return blocks;
  if (!Array.isArray(blocks)) return "";
  const parts = [];
  for (const b of blocks) {
    if (typeof b === "string") { parts.push(b); continue; }
    if (b && b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n");
}

// ------------------------------------------------- Anthropic -> OpenAI (req)

function anthropicToOpenAI(body, prov) {
  const { fwd, rev } = buildToolMaps(body.tools);
  const messages = [];

  const sysText = textOfBlocks(body.system);
  if (sysText && sysText.trim()) messages.push({ role: "system", content: sysText });

  for (const m of body.messages || []) {
    const role = m.role;
    const content = m.content;

    if (typeof content === "string") {
      if (content) messages.push({ role, content });
      continue;
    }
    if (!Array.isArray(content)) continue;

    if (role === "user") {
      const toolMsgs = [], parts = [];
      for (const b of content) {
        if (!b || typeof b !== "object") continue;
        if (b.type === "tool_result") {
          let c = typeof b.content === "string" ? b.content : textOfBlocks(b.content);
          if (b.is_error) c = `ERROR: ${c}`;
          toolMsgs.push({ role: "tool", tool_call_id: b.tool_use_id, content: c || "(empty)" });
        } else if (b.type === "text") {
          parts.push(b.text || "");
        } else if (b.type === "image") {
          if (prov.images === "url" && b.source?.type === "base64") {
            parts.push({ __image: `data:${b.source.media_type};base64,${b.source.data}` });
          } else {
            parts.push("[image omitted]");
          }
        }
      }
      // tool 応答は対応する assistant tool_calls の直後に置く必要がある.
      for (const tm of toolMsgs) messages.push(tm);
      const imgs = parts.filter((p) => p && p.__image);
      const txt = parts.filter((p) => typeof p === "string").join("\n");
      if (imgs.length) {
        const arr = [];
        if (txt) arr.push({ type: "text", text: txt });
        for (const im of imgs) arr.push({ type: "image_url", image_url: { url: im.__image } });
        messages.push({ role: "user", content: arr });
      } else if (txt.trim()) {
        messages.push({ role: "user", content: txt });
      }
      continue;
    }

    if (role === "assistant") {
      const texts = [], toolCalls = [];
      for (const b of content) {
        if (!b || typeof b !== "object") continue;
        if (b.type === "text") texts.push(b.text || "");
        else if (b.type === "tool_use") {
          toolCalls.push({
            id: b.id, type: "function",
            function: { name: fwd.get(b.name) || b.name, arguments: JSON.stringify(b.input ?? {}) },
          });
        }
        // thinking / redacted_thinking は落とす.
      }
      const msg = { role: "assistant", content: texts.join("\n") };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      if (msg.content || toolCalls.length) messages.push(msg);
      continue;
    }
  }

  const payload = { model: baseModelName(body.model), messages, stream: !!body.stream };
  const mt = Number(body.max_tokens || 0);
  payload.max_tokens = Math.min(mt > 0 ? mt : CFG.maxTokens, CFG.maxTokens);
  if (typeof body.temperature === "number") payload.temperature = body.temperature;
  if (typeof body.top_p === "number") payload.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) payload.stop = body.stop_sequences.slice(0, 4);
  if (payload.stream) payload.stream_options = { include_usage: true };

  if (Array.isArray(body.tools) && body.tools.length) {
    payload.tools = body.tools.filter((t) => t && t.name).map((t) => ({
      type: "function",
      function: {
        name: fwd.get(t.name) || t.name,
        description: (t.description || "").slice(0, 8192),
        parameters: stripSchema(t.input_schema),
      },
    }));
    const tc = body.tool_choice;
    if (tc?.type === "any") payload.tool_choice = "required";
    else if (tc?.type === "tool" && tc.name) payload.tool_choice = { type: "function", function: { name: fwd.get(tc.name) || tc.name } };
    else if (tc?.type === "none") payload.tool_choice = "none";
    else payload.tool_choice = "auto";
  }

  return { payload, rev };
}

// ------------------------------------------------ OpenAI -> Anthropic (resp)

const STOP_MAP = { stop: "end_turn", tool_calls: "tool_use", length: "max_tokens", content_filter: "end_turn" };

function usageOut(u, inEst) {
  return {
    input_tokens: u?.prompt_tokens ?? inEst,
    output_tokens: u?.completion_tokens ?? 0,
    cache_read_input_tokens: u?.prompt_cache_hit_tokens ?? 0,
    cache_creation_input_tokens: 0,
  };
}

function parseArgs(raw, where) {
  if (!raw) return {};
  try { return JSON.parse(raw); }
  catch { log(`bridge WARN malformed tool arguments (${where}), substituting {}`); return {}; }
}

function openAIToAnthropic(resp, model, rev, inEst) {
  const choice = resp.choices?.[0] || {};
  const msg = choice.message || {};
  const content = [];
  if (CFG.emitThinking && msg.reasoning_content) {
    content.push({ type: "thinking", thinking: msg.reasoning_content, signature: "" });
  }
  if (msg.content) content.push({ type: "text", text: msg.content });
  for (const tc of msg.tool_calls || []) {
    content.push({
      type: "tool_use",
      id: tc.id || `toolu_${Math.random().toString(36).slice(2)}`,
      name: rev.get(tc.function?.name) || tc.function?.name,
      input: parseArgs(tc.function?.arguments, "non-stream"),
    });
  }
  if (!content.length) content.push({ type: "text", text: "" });
  return {
    id: `msg_${resp.id || Math.random().toString(36).slice(2)}`,
    type: "message", role: "assistant", model, content,
    stop_reason: STOP_MAP[choice.finish_reason] || "end_turn",
    stop_sequence: null,
    usage: usageOut(resp.usage, inEst),
  };
}

// Anthropic の SSE イベント列を組み立てる.
class SSEWriter {
  constructor(res, model, inEst) {
    this.res = res; this.model = model; this.inEst = inEst;
    this.index = -1; this.open = null;
  }
  send(event, data) { this.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
  start() {
    this.send("message_start", {
      type: "message_start",
      message: {
        id: `msg_${Math.random().toString(36).slice(2)}`,
        type: "message", role: "assistant", model: this.model,
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: this.inEst, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    });
  }
  closeBlock() {
    if (this.open === null) return;
    if (this.open === "thinking") {
      this.send("content_block_delta", { type: "content_block_delta", index: this.index, delta: { type: "signature_delta", signature: "" } });
    }
    this.send("content_block_stop", { type: "content_block_stop", index: this.index });
    this.open = null;
  }
  openBlock(kind, block) {
    this.closeBlock();
    this.index += 1;
    this.open = kind;
    this.send("content_block_start", { type: "content_block_start", index: this.index, content_block: block });
    return this.index;
  }
  thinkingDelta(t) {
    if (this.open !== "thinking") this.openBlock("thinking", { type: "thinking", thinking: "" });
    this.send("content_block_delta", { type: "content_block_delta", index: this.index, delta: { type: "thinking_delta", thinking: t } });
  }
  textDelta(t) {
    if (this.open !== "text") this.openBlock("text", { type: "text", text: "" });
    this.send("content_block_delta", { type: "content_block_delta", index: this.index, delta: { type: "text_delta", text: t } });
  }
  // tool_use は名前も引数も分割・順不同で届きうるため, 全チャンク受信後にまとめて出す.
  flushTools(slots, rev) {
    for (const slot of [...slots.keys()].sort((a, b) => a - b)) {
      const s = slots.get(slot);
      if (!s || !s.name) continue;
      const input = parseArgs(s.args, `slot ${slot}`);
      const idx = this.openBlock("tool", {
        type: "tool_use",
        id: s.id || `toolu_${Math.random().toString(36).slice(2)}`,
        name: rev.get(s.name) || s.name,
        input: {},
      });
      this.send("content_block_delta", { type: "content_block_delta", index: idx, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } });
    }
  }
  finish(finishReason, usage) {
    this.closeBlock();
    this.send("message_delta", {
      type: "message_delta",
      delta: { stop_reason: STOP_MAP[finishReason] || "end_turn", stop_sequence: null },
      usage: usageOut(usage, this.inEst),
    });
    this.send("message_stop", { type: "message_stop" });
  }
  // SSE 開始後に失敗した場合は, 生 JSON でなく error イベントとして通知する.
  error(message) {
    this.closeBlock();
    this.send("error", { type: "error", error: { type: "api_error", message } });
  }
}

async function streamUpstream(upRes, res, model, rev, inEst) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const w = new SSEWriter(res, model, inEst);
  w.start();

  let finishReason = null, usage = null;
  const slots = new Map(); // index -> {id, name, args}

  try {
    const reader = upRes.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        let ev;
        try { ev = JSON.parse(payload); } catch { continue; }
        if (ev.usage) usage = ev.usage;
        const ch = ev.choices?.[0];
        if (!ch) continue;
        if (ch.finish_reason) finishReason = ch.finish_reason;
        const d = ch.delta || {};
        if (CFG.emitThinking && typeof d.reasoning_content === "string" && d.reasoning_content) w.thinkingDelta(d.reasoning_content);
        if (typeof d.content === "string" && d.content) w.textDelta(d.content);
        for (const tc of d.tool_calls || []) {
          const slot = tc.index ?? 0;
          let s = slots.get(slot);
          if (!s) { s = { id: null, name: "", args: "" }; slots.set(slot, s); }
          if (tc.id) s.id = tc.id;
          if (tc.function?.name) s.name += tc.function.name;
          if (tc.function?.arguments) s.args += tc.function.arguments;
        }
      }
    }
  } catch (e) {
    log(`bridge STREAM ABORTED model=${model} ${e?.message || e}`);
    w.error(`upstream stream failed: ${e?.message || e}`);
    return res.end();
  }

  if (finishReason === null && CFG.strictFinish) {
    log(`bridge STREAM TRUNCATED model=${model} (no finish_reason)`);
    w.error("upstream ended without finish_reason (response may be truncated)");
    return res.end();
  }

  w.flushTools(slots, rev);
  w.finish(finishReason ?? "stop", usage);
  res.end();
}

// ------------------------------------------------------------------ routing

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const HOP = new Set(["host", "content-length", "connection", "transfer-encoding", "accept-encoding", "keep-alive"]);

async function passthrough(req, res, raw, model) {
  const t0 = Date.now();
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP.has(k.toLowerCase()) && typeof v === "string") headers[k] = v;
  }
  const init = { method: req.method, headers };
  if (raw && raw.length) init.body = raw;
  const up = await fetch(CFG.upstream + req.url, init);
  const outHeaders = {};
  up.headers.forEach((v, k) => {
    const lk = k.toLowerCase();
    if (["content-encoding", "content-length", "transfer-encoding", "connection"].includes(lk)) return;
    outHeaders[k] = v;
  });
  res.writeHead(up.status, outHeaders);
  if (up.body) {
    const reader = up.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  }
  res.end();
  if (model) log(`anthropic passthrough model=${model} ${up.status} ${Date.now() - t0}ms`);
}

async function handleProvider(res, body, prov, t0) {
  const key = process.env[prov.keyEnv] || "";
  if (!key) {
    res.writeHead(401, { "content-type": "application/json" });
    return res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: `${prov.keyEnv} is not set for the bridge process` } }));
  }
  const { payload, rev } = anthropicToOpenAI(body, prov);
  const inEst = estimateTokens(payload.messages);
  const upRes = await fetch(prov.chatUrl, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!upRes.ok) {
    const txt = await upRes.text();
    log(`${prov.name} ERROR ${upRes.status} model=${payload.model} ${txt.slice(0, 400)}`);
    res.writeHead(upRes.status, { "content-type": "application/json" });
    return res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: `${prov.name} ${upRes.status}: ${txt.slice(0, 800)}` } }));
  }

  if (payload.stream) {
    await streamUpstream(upRes, res, body.model, rev, inEst);
    log(`${prov.name} stream ok model=${payload.model} tools=${payload.tools?.length ?? 0} ${Date.now() - t0}ms`);
    return;
  }
  const j = await upRes.json();
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(openAIToAnthropic(j, body.model, rev, inEst)));
  log(`${prov.name} json ok model=${payload.model} ${Date.now() - t0}ms`);
}

const server = http.createServer(async (req, res) => {
  const t0 = Date.now();
  try {
    if (req.url === "/__bridge/health") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({
        ok: true, upstream: CFG.upstream,
        providers: PROVIDERS.map((p) => ({ name: p.name, match: String(p.re), hasKey: !!process.env[p.keyEnv] })),
      }));
    }

    const isMessages = req.method === "POST" && /^\/v1\/messages(\?|$)/.test(req.url);
    const isCount = req.method === "POST" && /^\/v1\/messages\/count_tokens/.test(req.url);
    if (!isMessages && !isCount) return await passthrough(req, res, await readBody(req), null);

    const raw = await readBody(req);
    let body;
    try { body = JSON.parse(raw.toString("utf8")); } catch { return await passthrough(req, res, raw, null); }

    const prov = providerFor(body.model);
    if (!prov) return await passthrough(req, res, raw, body.model || "unknown");

    if (isCount) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ input_tokens: estimateTokens({ s: body.system, m: body.messages, t: body.tools }) }));
    }
    await handleProvider(res, body, prov, t0);
  } catch (e) {
    log(`bridge EXCEPTION ${req.method} ${req.url} ${e?.stack || e}`);
    // ヘッダ送出後に生 JSON を書くと SSE 本文が壊れるため, 経路を分ける.
    const err = { type: "error", error: { type: "api_error", message: String(e?.message || e) } };
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      try { res.end(JSON.stringify(err)); } catch {}
    } else {
      try { res.write(`event: error\ndata: ${JSON.stringify(err)}\n\n`); } catch {}
      try { res.end(); } catch {}
    }
  }
});

process.on("uncaughtException", (e) => log(`bridge uncaughtException ${e?.stack || e}`));
process.on("unhandledRejection", (e) => log(`bridge unhandledRejection ${e?.stack || e}`));

server.headersTimeout = 0;
server.requestTimeout = 0;
server.listen(CFG.port, CFG.host, () => {
  try { fs.writeFileSync(path.join(DIR, "bridge.pid"), String(process.pid)); } catch {}
  const keys = PROVIDERS.map((p) => `${p.name}=${process.env[p.keyEnv] ? "yes" : "NO"}`).join(" ");
  log(`bridge listening on http://${CFG.host}:${CFG.port} upstream=${CFG.upstream} keys[${keys}]`);
  if (CFG.debug) process.stderr.write(`bridge up on ${CFG.host}:${CFG.port}\n`);
});

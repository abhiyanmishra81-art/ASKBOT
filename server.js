// ASKBOT server: serves the chat page and relays messages to the Claude API.
// Your API key stays here on the server and is never sent to the browser.
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
// Works with any provider that offers an OpenAI-style chat API (Groq, Gemini, OpenRouter, ...).
// Defaults to Groq's free tier. Change these three settings to switch providers.
const API_KEY = process.env.LLM_API_KEY;
const API_URL = process.env.LLM_API_URL || "https://api.groq.com/openai/v1/chat/completions";
const MODEL = process.env.MODEL || "llama-3.3-70b-versatile";
const RATE_LIMIT = Number(process.env.RATE_LIMIT_PER_MINUTE || 15);
const PUBLIC_DIR = path.join(__dirname, "public");

const SYSTEM =
  "You are ASKBOT, a friendly, sharp chat assistant. Answer clearly and directly, usually in a few short paragraphs. " +
  "Write plain text only: no markdown symbols, no asterisks, no hashes. Use simple dashes for lists when needed. " +
  "If you are unsure, say so. Never claim to browse the web or know live information. " +
  "Reply in the language the person writes in.";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

// Simple per-IP rate limit (in memory). Protects your API bill.
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 60000);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > RATE_LIMIT;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, list] of hits) {
    if (!list.some((t) => now - t < 60000)) hits.delete(ip);
  }
}, 60000).unref();

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  return (fwd ? fwd.split(",")[0].trim() : req.socket.remoteAddress) || "unknown";
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error("too_large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function cleanMessages(raw) {
  if (!Array.isArray(raw)) return null;
  const msgs = raw
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }))
    .slice(-20);
  while (msgs.length && msgs[0].role !== "user") msgs.shift();
  if (!msgs.length || msgs[msgs.length - 1].role !== "user") return null;
  return msgs;
}

async function handleChat(req, res) {
  if (!API_KEY) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("The server has no LLM_API_KEY set.");
  }
  if (limited(clientIp(req))) {
    res.writeHead(429, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Too many messages. Wait a minute and try again.");
  }

  let messages;
  try {
    const body = JSON.parse(await readBody(req, 100 * 1024));
    messages = cleanMessages(body.messages);
  } catch {
    messages = null;
  }
  if (!messages) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Bad request.");
  }

  const abort = new AbortController();
  res.on("close", () => abort.abort());

  let upstream;
  try {
    upstream = await fetch(API_URL, {
      method: "POST",
      signal: abort.signal,
      headers: {
        Authorization: "Bearer " + API_KEY,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        stream: true,
        messages: [{ role: "system", content: SYSTEM }].concat(messages),
      }),
    });
  } catch {
    res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Could not reach the AI service.");
  }

  if (!upstream.ok) {
    console.error("AI API error", upstream.status, await upstream.text().catch(() => ""));
    const busy = upstream.status === 429;
    res.writeHead(busy ? 429 : 502, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end(busy ? "The free AI limit was reached. Try again in a minute." : "The AI service returned an error. Check the server logs.");
  }

  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Accel-Buffering": "no",
  });

  // Read the provider's event stream and forward only the text as it arrives.
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for await (const chunk of upstream.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        try {
          const payload = line.slice(6).trim();
          if (payload === "[DONE]") continue;
          const evt = JSON.parse(payload);
          const text = evt.choices && evt.choices[0] && evt.choices[0].delta && evt.choices[0].delta.content;
          if (text) res.write(text);
        } catch {
          /* ignore partial lines */
        }
      }
    }
  } catch {
    /* client left or stream ended early */
  }
  res.end();
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (urlPath === "/") urlPath = "/index.html";
  const file = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("Not found");
    }
    const type = MIME[path.extname(file)] || "application/octet-stream";
    const noCache = urlPath === "/sw.js" || urlPath === "/index.html";
    res.writeHead(200, { "Content-Type": type, "Cache-Control": noCache ? "no-cache" : "public, max-age=3600" });
    res.end(data);
  });
}

http
  .createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/chat") return handleChat(req, res);
    if (req.method === "GET" || req.method === "HEAD") return serveStatic(req, res);
    res.writeHead(405);
    res.end();
  })
  .listen(PORT, () => {
    console.log(`ASKBOT running on http://localhost:${PORT}`);
    if (!API_KEY) console.warn("Warning: LLM_API_KEY is not set.");
  });

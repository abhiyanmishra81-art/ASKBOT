// ASKBOT server.
// - Serves the chat page.
// - /api/chat   sends messages (and an optional picture) to the AI model. Default: Google Gemini free tier.
// - /api/image  draws pictures with Cloudflare Workers AI (FLUX). Optional.
// Your keys stay here on the server and never reach the browser.
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;

// Chat model. Any provider with an OpenAI-style chat API works.
const API_KEY = process.env.LLM_API_KEY;
const API_URL = process.env.LLM_API_URL || "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const MODEL = process.env.MODEL || "gemini-3.5-flash-lite";

// Image maker (optional).
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_API_TOKEN = process.env.CF_API_TOKEN;
const IMAGE_MODEL = process.env.IMAGE_MODEL || "@cf/black-forest-labs/flux-1-schnell";
const CF_BASE = process.env.CF_API_BASE || "https://api.cloudflare.com";

const CHAT_LIMIT = Number(process.env.RATE_LIMIT_PER_MINUTE || 15);
const IMAGE_LIMIT = Number(process.env.IMAGE_LIMIT_PER_MINUTE || 4);
const PUBLIC_DIR = path.join(__dirname, "public");

const SYSTEM =
  "You are ASKBOT, a friendly, sharp assistant in a chat app. Answer clearly and directly, usually in a few short paragraphs. " +
  "Write plain text only: no markdown symbols, no asterisks, no hashes. Use simple dashes for lists when needed. " +
  "You can look at pictures the person attaches and describe, read, or explain them. " +
  "The app has buttons you can mention when useful: Make image draws a picture from a description the person types, " +
  "PDF saves an answer or the whole chat as a PDF, Listen reads an answer aloud, and the microphone lets the person speak. " +
  "You cannot draw images yourself inside a reply, so when someone wants a picture drawn, tell them to type a description and tap Make image. " +
  "If you are unsure, say so. Never claim to browse the web or know live information. Reply in the language the person writes in. " +
  "Personality: you are playful, cheeky and full of masti, like a fun friend. Use light jokes and a little Hinglish when the person writes casually, but stay clear and helpful. " +
  "Your owner and creator is Abhiyan Sanjay Mishra (Vinious owner). If anyone asks who owns you, who made you, or who your boss is, say so proudly and with some masti, for example: " +
  "My owner is Abhiyan Sanjay Mishra, the Vinious owner. Boss level! " +
  "Never say you were made by Google or any other company, and do not name the AI model underneath.";

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

// Simple per-visitor rate limits (in memory). They protect your free allowance.
function makeLimiter(max) {
  const hits = new Map();
  const check = (ip) => {
    const now = Date.now();
    const recent = (hits.get(ip) || []).filter((t) => now - t < 60000);
    recent.push(now);
    hits.set(ip, recent);
    return recent.length > max;
  };
  check.sweep = () => {
    const now = Date.now();
    for (const [ip, list] of hits) if (!list.some((t) => now - t < 60000)) hits.delete(ip);
  };
  return check;
}
const chatLimited = makeLimiter(CHAT_LIMIT);
const imageLimited = makeLimiter(IMAGE_LIMIT);
setInterval(() => { chatLimited.sweep(); imageLimited.sweep(); }, 60000).unref();

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  return (fwd ? fwd.split(",")[0].trim() : req.socket.remoteAddress) || "unknown";
}

function text(res, code, msg) {
  res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(msg);
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

const IMG_PREFIX = "data:image/jpeg;base64,";
const MAX_IMAGE_CHARS = 2500000;

// Turns the browser's messages into the format the AI model expects.
// Only the newest picture is sent, to keep requests small.
function cleanMessages(raw) {
  if (!Array.isArray(raw)) return null;
  let msgs = raw
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map((m) => {
      const out = { role: m.role, content: m.content.slice(0, 4000) };
      if (m.role === "user" && typeof m.image === "string" && m.image.startsWith(IMG_PREFIX) && m.image.length < MAX_IMAGE_CHARS) {
        out.image = m.image;
      }
      return out;
    })
    .slice(-20);
  while (msgs.length && msgs[0].role !== "user") msgs.shift();
  if (!msgs.length || msgs[msgs.length - 1].role !== "user") return null;

  let lastImage = -1;
  msgs.forEach((m, i) => { if (m.image) lastImage = i; });
  return msgs.map((m, i) => {
    if (m.image && i === lastImage) {
      return {
        role: "user",
        content: [
          { type: "text", text: m.content },
          { type: "image_url", image_url: { url: m.image } },
        ],
      };
    }
    return { role: m.role, content: m.image ? m.content + " (a picture was attached here)" : m.content };
  });
}

async function handleChat(req, res) {
  if (!API_KEY) return text(res, 500, "The server has no LLM_API_KEY set.");
  if (chatLimited(clientIp(req))) return text(res, 429, "Too many messages. Wait a minute and try again.");

  let messages;
  try {
    const body = JSON.parse(await readBody(req, 4 * 1024 * 1024));
    messages = cleanMessages(body.messages);
  } catch {
    messages = null;
  }
  if (!messages) return text(res, 400, "Bad request.");

  const abort = new AbortController();
  res.on("close", () => abort.abort());

  let upstream;
  try {
    upstream = await fetch(API_URL, {
      method: "POST",
      signal: abort.signal,
      headers: { Authorization: "Bearer " + API_KEY, "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2048,
        stream: true,
        messages: [{ role: "system", content: SYSTEM }].concat(messages),
      }),
    });
  } catch {
    return text(res, 502, "Could not reach the AI service.");
  }

  if (!upstream.ok) {
    console.error("AI API error", upstream.status, await upstream.text().catch(() => ""));
    if (upstream.status === 429) return text(res, 429, "The free AI limit was reached. Try again in a minute.");
    return text(res, 502, "The AI service returned an error. Check the server logs.");
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
          const piece = evt.choices && evt.choices[0] && evt.choices[0].delta && evt.choices[0].delta.content;
          if (piece) res.write(piece);
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

async function handleImage(req, res) {
  if (!CF_ACCOUNT_ID || !CF_API_TOKEN) {
    return text(res, 501, "The image maker is not switched on yet.");
  }
  if (imageLimited(clientIp(req))) return text(res, 429, "Too many pictures. Wait a minute and try again.");

  let prompt = "";
  try {
    const body = JSON.parse(await readBody(req, 10 * 1024));
    prompt = typeof body.prompt === "string" ? body.prompt.trim().slice(0, 500) : "";
  } catch {
    prompt = "";
  }
  if (!prompt) return text(res, 400, "Type what you want drawn.");

  let r;
  try {
    r = await fetch(
      `${CF_BASE}/client/v4/accounts/${encodeURIComponent(CF_ACCOUNT_ID)}/ai/run/${IMAGE_MODEL}`,
      {
        method: "POST",
        signal: AbortSignal.timeout(60000),
        headers: { Authorization: "Bearer " + CF_API_TOKEN, "content-type": "application/json" },
        body: JSON.stringify({ prompt, steps: 4 }),
      }
    );
  } catch {
    return text(res, 502, "The image maker took too long. Try again.");
  }

  if (!r.ok) {
    console.error("Image API error", r.status, await r.text().catch(() => ""));
    if (r.status === 429) return text(res, 429, "The free image limit was reached. Try again later.");
    return text(res, 502, "The image maker returned an error. Check the server logs.");
  }

  let b64 = "";
  try {
    const j = await r.json();
    b64 = (j && j.result && j.result.image) || (j && j.image) || "";
  } catch {
    b64 = "";
  }
  if (!b64) return text(res, 502, "The image maker sent nothing back. Try a different description.");

  res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify({ image: IMG_PREFIX + b64 }));
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
    if (err) return text(res, 404, "Not found");
    const type = MIME[path.extname(file)] || "application/octet-stream";
    const noCache = urlPath === "/sw.js" || urlPath === "/index.html";
    res.writeHead(200, { "Content-Type": type, "Cache-Control": noCache ? "no-cache" : "public, max-age=3600" });
    res.end(data);
  });
}

http
  .createServer((req, res) => {
    const pathname = (req.url || "").split("?")[0];
    if (req.method === "POST" && pathname === "/api/chat") return handleChat(req, res);
    if (req.method === "POST" && pathname === "/api/image") return handleImage(req, res);
    if (req.method === "GET" && pathname === "/api/config") {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return res.end(JSON.stringify({ images: Boolean(CF_ACCOUNT_ID && CF_API_TOKEN) }));
    }
    if (req.method === "GET" || req.method === "HEAD") return serveStatic(req, res);
    res.writeHead(405);
    res.end();
  })
  .listen(PORT, () => {
    console.log(`ASKBOT running on http://localhost:${PORT}`);
    if (!API_KEY) console.warn("Warning: LLM_API_KEY is not set.");
    if (!CF_ACCOUNT_ID || !CF_API_TOKEN) console.log("Image maker is off (set CF_ACCOUNT_ID and CF_API_TOKEN to turn it on).");
  });

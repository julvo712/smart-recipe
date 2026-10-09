#!/usr/bin/env node
// HTTP sidecar exposing recipe→MC-draft conversion for rewe-cart.
// Needs env: OPENAI_API_KEY, MC_COOKIE, MC_LOCALE (defaults: model glm-5.3-flash
// + effort high + base https://ollama.com/v1 are baked into the fork).
import process from "node:process";
import { createServer } from "node:http";
import { writeFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { importRecipe, MonsieurCuisineAdapter, MonsieurCuisineSmartClient, RecipePageRetriever, transcribeRecipePhotos } from "../dist/index.js";

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_IMAGES = 6;

const PORT = Number(process.env.PORT ?? 8200);
const LOCALE = process.env.MC_LOCALE ?? "de-DE";

function pageOf(title, markdown) {
  return { url: "", finalUrl: "", title: title ?? "Rezept", markdown: markdown ?? "", html: "", images: [] };
}

function handleIngestUrl(req, res) {
  const start = Date.now();
  readBody(req, res, async (err, buf) => {
    if (err || buf === null) return;
    let body;
    try { body = JSON.parse(buf.toString("utf8")); } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid json" }));
      return;
    }
    if (!body.url || !/^https?:\/\//.test(String(body.url))) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "missing or invalid url" }));
      return;
    }
    try {
      const page = await new RecipePageRetriever().retrieve(String(body.url));
      console.log(`[mc-convert] ingest-url ${body.url} bytes=${buf.length} markdown=${(page.markdown ?? "").length}ms=${Date.now() - start}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ markdown: page.markdown ?? "", title: page.title ?? "Rezept" }));
    } catch (e) {
      console.log(`[mc-convert] ingest-url ${body.url} failed after ${Date.now() - start}ms: ${String(e && e.message ? e.message : e)}`);
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(e && e.message ? e.message : e) }));
    }
  });
}

function handleTranscribe(req, res) {
  const start = Date.now();
  readBody(req, res, async (err, buf) => {
    if (err || buf === null) return;
    let body;
    try { body = JSON.parse(buf.toString("utf8")); } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid json" }));
      return;
    }
    const images = Array.isArray(body.images) ? body.images : null;
    if (!images || images.length === 0) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "missing images array" }));
      return;
    }
    if (images.length > MAX_IMAGES) {
      tooLarge(res, `too many images: ${images.length} > ${MAX_IMAGES}`);
      return;
    }
    // Decode data URLs up front; a malformed image aborts before any tmp writes pile up.
    const buffers = [];
    for (let i = 0; i < images.length; i++) {
      const m = /^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(images[i]));
      if (!m) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `malformed data URL at images[${i}]` }));
        return;
      }
      try { buffers.push(Buffer.from(m[2], "base64")); } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `undecodable base64 at images[${i}]` }));
        return;
      }
    }
    const paths = [];
    try {
      for (let i = 0; i < buffers.length; i++) {
        const p = `/tmp/mc-sidecar-img-${randomUUID()}.jpg`;
        await writeFile(p, buffers[i]);
        paths.push(p);
      }
      const page = await transcribeRecipePhotos(paths, { locale: body.locale ?? LOCALE });
      console.log(`[mc-convert] transcribe images=${images.length} bytes=${buf.length} markdown=${(page.markdown ?? "").length}ms=${Date.now() - start}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ markdown: page.markdown ?? "", title: page.title ?? "Rezept" }));
    } catch (e) {
      console.log(`[mc-convert] transcribe failed after ${Date.now() - start}ms: ${String(e && e.message ? e.message : e)}`);
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(e && e.message ? e.message : e) }));
    } finally {
      for (const p of paths) await unlink(p).catch(() => {});
    }
  });
}

function tooLarge(res, msg) {
  console.log(`[mc-convert] rejected: ${msg}`);
  res.writeHead(413, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: msg }));
}

// Reads the request body, enforcing MAX_BODY_BYTES.
function readBody(req, res, cb) {
  const chunks = [];
  let size = 0;
  req.on("data", (c) => {
    size += c.length;
    if (size > MAX_BODY_BYTES) {
      req.removeAllListeners("data");
      req.removeAllListeners("end");
      tooLarge(res, `body exceeds ${MAX_BODY_BYTES} bytes`);
      return;
    }
    chunks.push(c);
  });
  req.on("end", () => cb(null, Buffer.concat(chunks)));
  req.on("error", (e) => cb(e, null));
}

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, cookie: Boolean(process.env.MC_COOKIE), key: Boolean(process.env.OPENAI_API_KEY) }));
    return;
  }
  if (req.method === "POST" && req.url === "/bookmark") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid json" }));
        return;
      }
      if (!body.translationId) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "missing translationId" }));
        return;
      }
      const client = new MonsieurCuisineSmartClient({
        baseUrl: "https://www.monsieur-cuisine.com",
        cookie: process.env.MC_COOKIE ?? "",
        locale: (body.locale ?? LOCALE)
      });
      try {
        await client.proxy({ endpoint: "api/v1/bookmarks", method: "POST", payload: { translationId: Number(body.translationId) } });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        const msg = String(e && e.message ? e.message : e);
        // Already favorited is an idempotent success (vendor answers HTTP 409).
        if (msg.includes("409")) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, duplicate: true }));
          return;
        }
        console.log(`[mc-convert] bookmark ${body.translationId} failed: ${msg}`);
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: msg }));
      }
    });
    return;
  }
  if (req.method === "GET" && req.url.startsWith("/bookmarks")) {
    const client = new MonsieurCuisineSmartClient({
      baseUrl: "https://www.monsieur-cuisine.com",
      cookie: process.env.MC_COOKIE ?? "",
      locale: LOCALE
    });
    const parts = req.url.split("page/");
    const pageNum = parts[1] ? Number(parts[1].split("/")[0]) : 1;
    (async () => {
      try {
        const result = await client.proxy({ endpoint: `api/v2/bookmarks/recipe/page/${pageNum}`, method: "GET" });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(e && e.message ? e.message : e) }));
      }
    })();
    return;
  }
  if (req.method === "POST" && req.url === "/ingest-url") {
    handleIngestUrl(req, res);
    return;
  }
  if (req.method === "POST" && req.url === "/transcribe") {
    handleTranscribe(req, res);
    return;
  }
  if (req.method !== "POST" || req.url !== "/convert") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "use POST /convert" }));
    return;
  }
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid json" }));
      return;
    }
    if (!body.markdown || !body.markdown.trim()) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "missing markdown" }));
      return;
    }
    try {
      const result = await importRecipe({
        page: pageOf(body.title, body.markdown),
        locale: body.locale ?? LOCALE,
        cookie: process.env.MC_COOKIE ?? "",
        dryRun: Boolean(body.dryRun),
        adapter: new MonsieurCuisineAdapter()
      });
      const draftId = result.draft && typeof result.draft === "object" ? (result.draft.id ?? null) : (result.draft ?? null);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        draftUrl: typeof result.recipeUrl === "string" ? result.recipeUrl : (typeof draftId === "object" ? draftId : result.recipeUrl ?? null),
        draftId,
        recipeInput: body.includeRecipeInput ? result.recipeInput : undefined
      }));
    } catch (e) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(e && e.message ? e.message : e) }));
    }
  });
});

server.on("connection", (socket) => {
  socket.setTimeout(120000);
  socket.on("timeout", () => {
    console.log(`[mc-convert] socket idle >120s, destroying ${socket.remoteAddress ?? ""}`);
    socket.destroy();
  });
});

server.listen(PORT, () => {
  console.log(`[mc-convert] listening on :${PORT} cookie=${Boolean(process.env.MC_COOKIE)} key=${Boolean(process.env.OPENAI_API_KEY)} locale=${LOCALE}`);
});
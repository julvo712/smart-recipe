#!/usr/bin/env node
// HTTP sidecar exposing recipe→MC-draft conversion for rewe-cart.
// Needs env: OPENAI_API_KEY, MC_COOKIE, MC_LOCALE (defaults: model glm-5.3-flash
// + effort high + base https://ollama.com/v1 are baked into the fork).
import process from "node:process";
import { createServer } from "node:http";
import { importRecipe, MonsieurCuisineAdapter, MonsieurCuisineSmartClient } from "../dist/index.js";

const PORT = Number(process.env.PORT ?? 8200);
const LOCALE = process.env.MC_LOCALE ?? "de-DE";

function pageOf(title, markdown) {
  return { url: "", finalUrl: "", title: title ?? "Rezept", markdown: markdown ?? "", html: "", images: [] };
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
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(e && e.message ? e.message : e) }));
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

server.listen(PORT, () => {
  console.log(`[mc-convert] listening on :${PORT} cookie=${Boolean(process.env.MC_COOKIE)} key=${Boolean(process.env.OPENAI_API_KEY)} locale=${LOCALE}`);
});
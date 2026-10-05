import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterAll, describe, expect, it } from "vitest";
import { transcribeRecipePhotos } from "../src/sources/photo-ocr.js";
import type OpenAI from "openai";

const asClient = (mock: unknown) => mock as OpenAI;

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const dir = await mkdtemp(path.join(os.tmpdir(), "photo-ocr-"));

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function mockClient(content: string, captured: unknown[]) {
  return {
    chat: {
      completions: {
        create: async (body: unknown) => {
          captured.push(body);
          return { choices: [{ message: { content } }] };
        }
      }
    }
  };
}

describe("transcribeRecipePhotos", () => {
  it("transcribes a photo into a recipe page with the photo attached", async () => {
    const photoPath = path.join(dir, "page.jpg");
    await writeFile(photoPath, Buffer.from(PNG_BASE64, "base64"));

    const captured: unknown[] = [];
    const client = mockClient("# Tomato Soup\n\n## Ingredients\n\n- 800 g tomatoes\n", captured);

    const page = await transcribeRecipePhotos([photoPath], { client: asClient(client), model: "vl-test" });

    expect(page.title).toBe("page");
    expect(page.markdown).toContain("## Ingredients");
    expect(page.images).toHaveLength(1);
    expect(page.images[0].dataUrl).toMatch(/^data:image\/jpeg;base64,/);

    const body = captured[0] as { model: string; messages: Array<{ content: unknown }> };
    expect(body.model).toBe("vl-test");
    expect(JSON.stringify(body.messages)).toContain("data:image");
  });

  it("keeps multi-photo order and respects an explicit title", async () => {
    const p1 = path.join(dir, "part1.png");
    const p2 = path.join(dir, "part2.png");
    await writeFile(p1, Buffer.from(PNG_BASE64, "base64"));
    await writeFile(p2, Buffer.from(PNG_BASE64, "base64"));

    const captured: unknown[] = [];
    const client = mockClient("# Full Recipe", captured);

    const page = await transcribeRecipePhotos([p1, p2], { client: asClient(client), model: "vl-test", title: "Kartoffelsuppe" });

    expect(page.title).toBe("Kartoffelsuppe");
    expect(page.images.map((i) => i.url)).toEqual([p1, p2]);
    const body = captured[0] as { messages: Array<{ content: string | Array<{ text?: string }> }> };
    const userMessage = body.messages.at(-1) as { content: Array<{ text?: string }> };
    const hintText = userMessage.content.find((part) => typeof part.text === "string")?.text ?? "";
    expect(hintText).toContain("in this exact order");
  });

  it("rejects unsupported file types before calling the model", async () => {
    const bad = path.join(dir, "page.txt");
    await writeFile(bad, "not an image");
    const captured: unknown[] = [];
    const client = mockClient("ignored", captured);

    await expect(transcribeRecipePhotos([bad], { client: asClient(client), model: "vl-test" })).rejects.toThrow(/Unsupported photo type/);
    expect(captured).toHaveLength(0);
  });
});
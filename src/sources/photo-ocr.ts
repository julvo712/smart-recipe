import { readFile } from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { RetrievedRecipePage, RetrievedImage } from "../retriever/types.js";
import { createLogger, type SmartRecipeLogger } from "../logging/logger.js";

const MIME_BY_EXTENSION: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp"
};

/** Ollama vision model identifier via OPENAI_VL_MODEL (no safe default — pick from ollama.com/search). */
export function visionModelName(): string {
  const value = (process.env.OPENAI_VL_MODEL ?? "").trim();
  if (!value) {
    throw new Error(
      "OPENAI_VL_MODEL is not set. Set it to a vision-capable model, e.g. OPENAI_VL_MODEL=qwen3-vl:8b (see https://ollama.com/search?c=vision)."
    );
  }
  return value;
}

function mimeTypeFor(filePath: string): string | undefined {
  return MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()];
}

interface LoadedPhoto {
  filePath: string;
  dataUrl: string;
  image: RetrievedImage;
}

async function loadPhoto(filePath: string): Promise<LoadedPhoto> {
  const mimeType = mimeTypeFor(filePath);
  if (!mimeType) {
    throw new Error(`Unsupported photo type: ${filePath} (supported: jpg, jpeg, png, webp)`);
  }
  const bytes = new Uint8Array(await readFile(filePath));
  const dataUrl = `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
  return {
    filePath,
    dataUrl,
    image: {
      url: filePath,
      contentType: mimeType,
      bytes,
      dataUrl,
      score: 1,
      reason: "cookbook photo"
    }
  };
}

export interface TranscribeRecipePhotosOptions {
  client?: OpenAI;
  model?: string;
  locale?: string;
  title?: string;
  logger?: SmartRecipeLogger;
}

/**
 * Transcribes cookbook photos into structured recipe markdown with a vision model,
 * producing a RetrievedRecipePage that feeds the normal generation pipeline.
 * The photos stay attached as image candidates so the draft can use one directly.
 */
export async function transcribeRecipePhotos(
  photoPaths: string[],
  options: TranscribeRecipePhotosOptions = {}
): Promise<RetrievedRecipePage> {
  if (photoPaths.length === 0) {
    throw new Error("No photo paths given.");
  }
  const logger = options.logger ?? createLogger();
  const client = options.client ?? new OpenAI({
    baseURL: process.env.OPENAI_BASE_URL ?? "https://ollama.com/v1",
    apiKey: process.env.OPENAI_API_KEY || "ollama"
  });
  const model = options.model ?? visionModelName();
  const locale = options.locale ?? "de-DE";

  const resolvedPaths = photoPaths.map((p) => path.resolve(p));
  const loaded: LoadedPhoto[] = [];
  for (const filePath of resolvedPaths) {
    loaded.push(await loadPhoto(filePath));
  }

  const pagesHint = loaded.length > 1
    ? `The photos are recipe pages ${loaded.map((p, i) => `#${i + 1} = ${path.basename(p.filePath)}`).join(", ")} of one recipe, in this exact order. Merge them into one coherent recipe.`
    : "The photo shows a single recipe page.";

  const messages: ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: [
        "You transcribe cookbook and magazine recipe photos into a clean, unambiguous Markdown recipe.",
        "Do not interpret, adapt or improve the recipe — transcribe exactly what is written (you may normalize formatting).",
        "Structure: a '# Title' heading, a '**Servings/Yield**' line, '## Ingredients' as one bullet per ingredient with exact amounts and units,",
        "then '## Instructions' as an ordered list with one action per step, then '## Tips' only if the photo includes tips.",
        "If a number or word is unreadable, write the most plausible reading followed by '[?]' and add a note under '## Transcription Notes'.",
        `Write the transcription in ${locale}.`
      ].join(" ")
    },
    {
      role: "user",
      content: [
        { type: "text", text: `Transcribe this recipe into Markdown. ${pagesHint}` },
        ...loaded.map((photo) => ({
          type: "image_url" as const,
          image_url: { url: photo.dataUrl }
        }))
      ]
    }
  ];

  logger.info({ model, photos: loaded.length }, "transcribing recipe photos");
  const response = await client.chat.completions.create({
    model,
    messages,
    temperature: 0
  });

  const content = response.choices[0]?.message?.content;
  if (typeof content !== "string" || content.trim() === "") {
    throw new Error("Vision model returned an empty transcription.");
  }
  const markdown = stripCodeFences(content);

  const fallbackTitle = options.title ?? path.basename(resolvedPaths[0], path.extname(resolvedPaths[0]));
  return {
    url: "",
    finalUrl: "",
    title: fallbackTitle,
    markdown,
    html: "",
    images: loaded.map((photo) => ({
      url: photo.image.url,
      contentType: photo.image.contentType,
      bytes: photo.image.bytes,
      score: photo.image.score,
      reason: photo.image.reason
    }))
  };
}

function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const fence = trimmed.match(/^```(?:markdown)?\s*\n([\s\S]*?)\n?```$/);
  return fence && typeof fence[1] === "string" ? fence[1].trim() : trimmed;
}
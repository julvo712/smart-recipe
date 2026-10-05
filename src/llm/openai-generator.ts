import OpenAI from "openai";
import type { ChatCompletionContentPart, ChatCompletionUserMessageParam } from "openai/resources/chat/completions.js";
import type { RetrievedRecipePage } from "../retriever/types.js";
import type { RecipeInput } from "../recipes/schema.js";
import type { RecipeGenerationOptions, RecipeGenerator } from "./types.js";
import { makeOpenAIStrictSchema } from "./schema-format.js";
import { getArray, getRecord, getString } from "../utils/unknown.js";
import type { ReasoningEffort } from "./types.js";

type GenerationDefaults = Required<Omit<RecipeGenerationOptions, "adapter">> & Pick<RecipeGenerationOptions, "adapter">;

export interface OpenAIRecipeGeneratorOptions extends RecipeGenerationOptions {
  client?: OpenAI;
  adapter: NonNullable<RecipeGenerationOptions["adapter"]>;
}

export class OpenAIRecipeGenerator implements RecipeGenerator {
  private readonly client: OpenAI;
  private readonly defaults: GenerationDefaults;

  constructor(options: OpenAIRecipeGeneratorOptions) {
    this.client = options.client ?? new OpenAI();
    this.defaults = {
      model: options.model ?? process.env.OPENAI_MODEL ?? "gpt-oss:120b",
      reasoningEffort: options.reasoningEffort ?? parseReasoningEffort(process.env.OPENAI_REASONING_EFFORT),
      locale: options.locale ?? "de-DE",
      maxCorrectionAttempts: options.maxCorrectionAttempts ?? 3,
      excludeModes: options.excludeModes ?? [],
      adapter: options.adapter
    };
  }

  async generate(page: RetrievedRecipePage, options: RecipeGenerationOptions = {}): Promise<RecipeInput> {
    const cleanOptions = Object.fromEntries(
      Object.entries(options).filter(([_, v]) => v !== undefined)
    );
    const mergedOptions = { ...this.defaults, ...cleanOptions } as GenerationDefaults;
    if (!mergedOptions.adapter) {
      throw new Error("OpenAIRecipeGenerator requires a device adapter.");
    }
    const finalOptions = mergedOptions as Required<RecipeGenerationOptions>;
    let feedback: { errors: string[]; previous: unknown } | undefined;

    const adapter = finalOptions.adapter;

    for (let attempt = 0; attempt <= finalOptions.maxCorrectionAttempts; attempt += 1) {
      const output = await this.generateOnce(page, finalOptions, feedback);
      const validation = adapter.validateInput(output);
      const excludedErrors = validateExcludedModes(output, finalOptions.excludeModes);
      const allErrors = [...validation.errors, ...excludedErrors];
      if (validation.ok && excludedErrors.length === 0) {
        return adapter.normalizeInput(output) as RecipeInput;
      }
      feedback = { errors: allErrors, previous: output };
    }

    throw new Error(`OpenAI output failed validation after ${finalOptions.maxCorrectionAttempts} correction attempts:\n${feedback?.errors.join("\n")}`);
  }

  private async generateOnce(
    page: RetrievedRecipePage,
    options: Required<RecipeGenerationOptions>,
    feedback?: { errors: string[]; previous: unknown }
  ): Promise<unknown> {
    const adapter = options.adapter;
    const schema = adapter.getSchema(options);
    const strictSchema = makeOpenAIStrictSchema(schema);
    const fullSchemaText = JSON.stringify(schema, null, 2);
    const correctionText = feedback
      ? [
        "Previous generated JSON failed validation.",
        "Validation errors:",
        feedback.errors.join("\n"),
        "",
        "Previous JSON:",
        JSON.stringify(feedback.previous, null, 2),
        "",
        "Return corrected JSON only."
      ].join("\n")
      : "";

    // Ollama-compatible transport: /v1/chat/completions with a strict JSON Schema response
    // format. Ollama's /v1/responses does not support text.format.json_schema, so the
    // generator targets chat.completions (supported by both OpenAI-compatible servers).
    const response = await this.client.chat.completions.create({
      model: options.model,
      reasoning_effort: options.reasoningEffort,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: adapter.id === "tm" ? "thermomix_cookidoo_recipe" : "monsieur_cuisine_smart_recipe",
          strict: true,
          schema: strictSchema
        }
      },
      messages: [
        {
          role: "system",
          content: adapter.getPromptInstructions(options.locale, options)
        },
        {
          role: "user",
          // The wire API (and Ollama) accept image_url parts on user messages, but the
          // SDK v6 user-message param type narrows content to text/refusal — one scoped cast.
          content: buildUserContent(page, options, fullSchemaText, correctionText) as ChatCompletionUserMessageParam["content"]
        }
      ]
    });

    const content = response.choices[0]?.message?.content;
    if (typeof content !== "string" || content.trim() === "") {
      throw new Error("Chat completion returned an empty message content.");
    }
    return JSON.parse(stripCodeFences(content));
  }
}

/**
 * Checks that none of the recipe steps use a mode that was excluded for this generation run.
 * Returns an array of human-readable error strings suitable for feeding back to the LLM.
 */
function validateExcludedModes(output: unknown, excludeModes: string[] = []): string[] {
  const finalExcludeModes = excludeModes ?? [];
  if (!finalExcludeModes.length || typeof output !== "object" || !output) return [];
  const excluded = new Set(finalExcludeModes);
  const errors: string[] = [];

  // MC structure
  const mcSteps = getArray(getRecord(output, "servingSize"), "steps");
  mcSteps.forEach((step, index) => {
    const modeType = getString(getRecord(step, "mode"), "type");
    if (modeType && excluded.has(modeType)) {
      errors.push(`/servingSize/steps/${index}/mode/type must not be "${modeType}" — this mode requires an accessory the user does not own. Replace it with an alternative mode or type "none".`);
    }
  });

  // TM structure
  const tmSteps = getArray(output, "steps");
  tmSteps.forEach((step, index) => {
    const annotations = getArray(step, "modeAnnotations");
    annotations.forEach((ann, annIdx) => {
      const modeType = getString(getRecord(ann, "mode"), "type");
      if (modeType && excluded.has(modeType)) {
        errors.push(`/steps/${index}/modeAnnotations/${annIdx}/mode/type must not be "${modeType}" — this mode requires an accessory the user does not own. Replace it with an alternative mode.`);
      }
    });
  });

  return errors;
}

/**
 * Ollama-compatible servers may wrap JSON in markdown code fences despite the
 * strict response_format; strip them before parsing.
 */
function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const fence = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/);
  return fence && typeof fence[1] === "string" ? fence[1].trim() : trimmed;
}

/**
 * Builds the user message content: the recipe brief plus up to three base64 image parts.
 */
function buildUserContent(
  page: RetrievedRecipePage,
  options: Required<RecipeGenerationOptions>,
  fullSchemaText: string,
  correctionText: string
): ChatCompletionContentPart[] {
  const textPart: ChatCompletionContentPart = {
    type: "text",
    text: [
      `Source URL: ${page.finalUrl || page.url}`,
      `Detected title: ${page.title}`,
      `Preferred locale: ${options.locale}`,
      "",
      "Full schema with detailed descriptions:",
      fullSchemaText,
      correctionText,
      "",
      "Recipe page as Markdown:",
      page.markdown
    ].filter(Boolean).join("\n")
  };
  const imageParts: ChatCompletionContentPart[] = page.images
    .filter((image): image is typeof image & { dataUrl: string } => typeof image.dataUrl === "string" && image.dataUrl !== "")
    .slice(0, 3)
    .map((image, index) => ({
      type: "image_url",
      image_url: {
        url: image.dataUrl,
        detail: index === 0 ? "high" : "low"
      }
    }));
  return [textPart, ...imageParts];
}

function parseReasoningEffort(value: string | undefined): ReasoningEffort {
  return value === "minimal" || value === "low" || value === "medium" || value === "high" ? value : "medium";
}

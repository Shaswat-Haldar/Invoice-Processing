import type { ExtractedInvoice } from "./types.js";

export class ExtractorError extends Error {
  statusCode?: number;
  retryAfterSeconds?: number;
}

const REQUEST_TIMEOUT_MS = Number(process.env.GEMINI_REQUEST_TIMEOUT_MS ?? 35000);
const MODEL_CACHE_TTL_MS = Number(process.env.GEMINI_MODELS_CACHE_TTL_MS ?? 5 * 60 * 1000);
let cachedModelList: { models: string[]; expiresAt: number } | null = null;

export async function extractInvoiceData(input: {
  fileBase64: string;
  mimeType: string;
  fileName: string;
}): Promise<ExtractedInvoice> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is missing. Add it in apps/api/.env.");
  }

  return extractWithGemini(input, apiKey);
}

async function extractWithGemini(
  input: { fileBase64: string; mimeType: string; fileName: string },
  apiKey: string
): Promise<ExtractedInvoice> {
  const modelCandidates = await getModelCandidates(apiKey);

  let latestError: unknown;
  for (const model of modelCandidates) {
    try {
      return await extractWithGeminiModel(input, apiKey, model);
    } catch (error) {
      latestError = error;
      if (isRetryableModelError(error)) {
        continue;
      }
      throw error;
    }
  }

  throw latestError instanceof Error ? latestError : new Error("Gemini extraction failed.");
}

async function extractWithGeminiModel(
  input: { fileBase64: string; mimeType: string; fileName: string },
  apiKey: string,
  model: string
): Promise<ExtractedInvoice> {
  const schemaInstructions = `
Return ONLY strict JSON using this exact shape:
{
  "vendorName": "string",
  "invoiceNumber": "string",
  "invoiceDate": "YYYY-MM-DD",
  "dueDate": "YYYY-MM-DD or empty",
  "currency": "ISO code",
  "subTotal": number,
  "tax": number,
  "total": number,
  "additionalFields": {
    "any_extra_field_name": "string value"
  },
  "confidence": number between 0 and 1,
  "lineItems": [
    {
      "description": "string",
      "quantity": number,
      "unitPrice": number,
      "amount": number
    }
  ]
}
Never include markdown, code fences, or extra text.
`;

  const prompt = `${schemaInstructions}
Extract values from the attached invoice document. Handle both scanned images and PDFs.
Capture ALL visible line items exhaustively, including service lines, discounts, shipping, handling, freight, and charges.
If there are invoice categories not represented in core fields, include them in additionalFields as key-value pairs.
If any numeric field appears with commas or currency symbols, normalize it to plain numeric format.
If any field is unavailable, set a sensible default.
`;
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        generationConfig: {
          temperature: 0.1,
          responseMimeType: "application/json"
        },
        contents: [
          {
            role: "user",
            parts: [
              { text: prompt },
              {
                inline_data: {
                  mime_type: input.mimeType,
                  data: input.fileBase64
                }
              }
            ]
          }
        ]
      })
    }
  );

  if (!response.ok) {
    const responseText = await response.text();
    const safeSnippet = responseText.slice(0, 250).replace(/\s+/g, " ");
    const error = new ExtractorError(
      `Gemini request failed with status ${response.status}. ${safeSnippet}`
    );
    error.statusCode = response.status;
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (!Number.isNaN(seconds) && seconds > 0) {
        error.retryAfterSeconds = seconds;
      }
    }
    throw error;
  }

  const data = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };

  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) {
    throw new Error("Gemini response did not contain text output.");
  }

  const parsed = safeJsonParse(raw);
  return sanitizeExtractedInvoice(parsed);
}

function sanitizeExtractedInvoice(data: Partial<ExtractedInvoice>): ExtractedInvoice {
  const lineItems = Array.isArray(data.lineItems)
    ? data.lineItems.map((item) => ({
        description: String(item?.description ?? "Item"),
        quantity: parseNumeric(item?.quantity, 1),
        unitPrice: parseNumeric(item?.unitPrice, 0),
        amount: parseNumeric(item?.amount, 0)
      }))
    : [];

  const confidence = parseNumeric(data.confidence, 0.75);
  return {
    vendorName: String(data.vendorName ?? "Unknown Vendor"),
    invoiceNumber: String(data.invoiceNumber ?? "N/A"),
    invoiceDate: String(data.invoiceDate ?? new Date().toISOString().slice(0, 10)),
    dueDate: data.dueDate ? String(data.dueDate) : undefined,
    currency: String(data.currency ?? "USD"),
    subTotal: parseNumeric(data.subTotal, 0),
    tax: parseNumeric(data.tax, 0),
    total: parseNumeric(data.total, 0),
    lineItems,
    additionalFields: sanitizeAdditionalFields(data.additionalFields),
    confidence: Math.min(1, Math.max(0, confidence))
  };
}

function sanitizeAdditionalFields(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .map(([key, entryValue]) => [String(key).trim(), stringifyValue(entryValue)] as const)
    .filter(([key, entryValue]) => key.length > 0 && entryValue.length > 0);

  return Object.fromEntries(entries);
}

function stringifyValue(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => stringifyValue(item)).filter(Boolean).join("; ");
  }
  if (value && typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }
  return "";
}

function parseNumeric(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.replace(/[^0-9.-]/g, "");
    const parsed = Number(normalized);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function isRetryableModelError(error: unknown): boolean {
  if (!(error instanceof ExtractorError)) {
    return false;
  }
  return error.statusCode === 429 || error.statusCode === 404 || error.statusCode === 400;
}

async function getModelCandidates(apiKey: string): Promise<string[]> {
  const configured = [
    process.env.GEMINI_MODEL_PRIMARY?.trim(),
    process.env.GEMINI_MODEL_FALLBACK?.trim()
  ].filter((value): value is string => !!value && value.length > 0);

  const defaults = [
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite",
    "gemini-1.5-flash",
    "gemini-1.5-pro"
  ];

  const discovered = await fetchGenerateContentModels(apiKey);
  const merged = [...configured, ...defaults, ...discovered];
  return merged.filter((value, index, self) => value.length > 0 && self.indexOf(value) === index);
}

async function fetchGenerateContentModels(apiKey: string): Promise<string[]> {
  if (cachedModelList && cachedModelList.expiresAt > Date.now()) {
    return cachedModelList.models;
  }

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
      { signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, 12000)) }
    );
    if (!response.ok) {
      return [];
    }
    const payload = (await response.json()) as {
      models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>;
    };
    const models = payload.models ?? [];
    const discovered = models
      .filter((model) => model.supportedGenerationMethods?.includes("generateContent"))
      .map((model) => (model.name ?? "").replace(/^models\//, ""))
      .filter((name) => name.length > 0);
    cachedModelList = {
      models: discovered,
      expiresAt: Date.now() + MODEL_CACHE_TTL_MS
    };
    return discovered;
  } catch {
    return [];
  }
}

function safeJsonParse(raw: string): Partial<ExtractedInvoice> {
  const tryParse = (value: string): Partial<ExtractedInvoice> | null => {
    try {
      return JSON.parse(value) as Partial<ExtractedInvoice>;
    } catch {
      return null;
    }
  };

  const direct = tryParse(raw);
  if (direct) {
    return direct;
  }

  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const sliced = raw.slice(firstBrace, lastBrace + 1);
    const recovered = tryParse(sliced);
    if (recovered) {
      return recovered;
    }
  }

  throw new Error("Gemini returned invalid JSON format.");
}

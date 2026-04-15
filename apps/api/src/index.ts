import cors from "cors";
import "dotenv/config";
import express from "express";
import { z } from "zod";
import { ExtractorError, extractInvoiceData } from "./extractor.js";
import {
  createInvoice,
  getInvoice,
  getSourcePayload,
  listInvoices,
  updateInvoiceStatus
} from "./store.js";
import type { ExtractedInvoice } from "./types.js";

const app = express();
const port = Number(process.env.API_PORT ?? 4000);

app.use(cors());
app.use(express.json({ limit: "15mb" }));

const createInvoiceSchema = z.object({
  fileName: z.string().min(1).max(255),
  mimeType: z.string().regex(/^(application\/pdf|image\/.+)$/i),
  fileBase64: z.string().min(1).max(12_000_000)
});

const extractedInvoiceSchema = z.object({
  vendorName: z.string().min(1),
  invoiceNumber: z.string().min(1),
  invoiceDate: z.string().min(1),
  dueDate: z.string().optional(),
  currency: z.string().min(3).max(3),
  subTotal: z.number(),
  tax: z.number(),
  total: z.number(),
  confidence: z.number().min(0).max(1),
  lineItems: z.array(
    z.object({
      description: z.string().min(1),
      quantity: z.number(),
      unitPrice: z.number(),
      amount: z.number()
    })
  )
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/invoices", (req, res) => {
  const parsed = createInvoiceSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      message: "Invalid request payload.",
      issues: parsed.error.issues
    });
  }

  const invoice = createInvoice({
    fileName: parsed.data.fileName,
    mimeType: normalizeMimeType(parsed.data.mimeType),
    fileBase64: parsed.data.fileBase64
  });

  void processInvoice(invoice.id);

  return res.status(201).json(invoice);
});

app.get("/invoices", (_req, res) => {
  return res.json(listInvoices());
});

app.get("/invoices/:id", (req, res) => {
  const invoice = getInvoice(req.params.id);
  if (!invoice) {
    return res.status(404).json({ message: "Invoice not found." });
  }
  return res.json(invoice);
});

app.get("/invoices/:id/source", (req, res) => {
  const invoice = getInvoice(req.params.id);
  const fileBase64 = getSourcePayload(req.params.id);
  if (!invoice || !fileBase64) {
    return res.status(404).json({ message: "Invoice source not found." });
  }
  return res.json({
    mimeType: invoice.mimeType,
    fileBase64
  });
});

app.post("/invoices/:id/retry", (req, res) => {
  const invoice = getInvoice(req.params.id);
  if (!invoice) {
    return res.status(404).json({ message: "Invoice not found." });
  }
  if (invoice.status === "queued" || invoice.status === "processing") {
    return res.status(409).json({ message: "Invoice is already processing." });
  }

  const queued = updateInvoiceStatus(invoice.id, "queued", { errorMessage: undefined });
  if (!queued) {
    return res.status(500).json({ message: "Could not queue invoice for retry." });
  }

  void processInvoice(invoice.id);
  return res.json(queued);
});

app.patch("/invoices/:id/extracted", (req, res) => {
  const invoice = getInvoice(req.params.id);
  if (!invoice) {
    return res.status(404).json({ message: "Invoice not found." });
  }

  const parsed = extractedInvoiceSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid extracted payload.", issues: parsed.error.issues });
  }

  const updated = updateInvoiceStatus(invoice.id, "processed", {
    extracted: parsed.data,
    errorMessage: undefined
  });
  return res.json(updated);
});

app.post("/invoices/:id/approve", (req, res) => {
  const invoice = getInvoice(req.params.id);
  if (!invoice) {
    return res.status(404).json({ message: "Invoice not found." });
  }
  if (!invoice.extracted) {
    return res.status(409).json({ message: "Invoice has no extracted data to approve." });
  }
  const approved = updateInvoiceStatus(invoice.id, "approved", { errorMessage: undefined });
  return res.json(approved);
});

app.get("/invoices/:id/csv", (req, res) => {
  const invoice = getInvoice(req.params.id);
  if (!invoice || !invoice.extracted) {
    return res.status(404).json({ message: "Invoice extracted data not found." });
  }
  const csv = toCsv(invoice.extracted);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${sanitizeFileName(invoice.fileName.replace(/\.[^.]+$/, ""))}.csv"`
  );
  return res.send(csv);
});

app.listen(port, () => {
  console.log(`API running on http://localhost:${port}`);
});

async function processInvoice(invoiceId: string): Promise<void> {
  const current = getInvoice(invoiceId);
  const sourcePayload = getSourcePayload(invoiceId);
  if (!current || current.status !== "queued") {
    return;
  }
  if (!sourcePayload) {
    updateInvoiceStatus(invoiceId, "failed", { errorMessage: "Missing source file payload." });
    return;
  }

  updateInvoiceStatus(invoiceId, "processing");

  try {
    const extracted = await extractWithRetries(
      {
        fileBase64: sourcePayload,
        mimeType: current.mimeType,
        fileName: current.fileName
      },
      2
    );
    const assessment = assessExtractionQuality(extracted);
    updateInvoiceStatus(invoiceId, assessment.status, {
      extracted,
      errorMessage: assessment.message
    });
  } catch (error) {
    if (isRateLimitError(error)) {
      const retryAfter = error.retryAfterSeconds ? `${error.retryAfterSeconds}s` : "a short time";
      updateInvoiceStatus(invoiceId, "needs_review", {
        errorMessage: `AI provider is rate-limited (429). Please retry in ${retryAfter}.`
      });
      return;
    }
    const errorMessage = error instanceof Error ? error.message : "Unknown extraction error";
    updateInvoiceStatus(invoiceId, "failed", { errorMessage });
  }
}

async function extractWithRetries(
  content: Parameters<typeof extractInvoiceData>[0],
  maxRetries: number
): Promise<Awaited<ReturnType<typeof extractInvoiceData>>> {
  let latestError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await extractInvoiceData(content);
    } catch (error) {
      latestError = error;
      if (attempt < maxRetries) {
        const nextDelay = getRetryDelayMs(error, attempt);
        await delay(nextDelay);
      }
    }
  }
  throw latestError instanceof Error ? latestError : new Error("Extraction failed after retries.");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(error: unknown): error is ExtractorError {
  return error instanceof ExtractorError && error.statusCode === 429;
}

function getRetryDelayMs(error: unknown, attempt: number): number {
  if (error instanceof ExtractorError && error.retryAfterSeconds) {
    return error.retryAfterSeconds * 1000;
  }
  return 1000 * Math.pow(2, attempt);
}

function assessExtractionQuality(
  extracted: Awaited<ReturnType<typeof extractInvoiceData>>
): { status: "processed" | "needs_review"; message?: string } {
  const confidenceTooLow = extracted.confidence < 0.65;
  const totals = reconcileTotals(extracted);

  if (confidenceTooLow) {
    return {
      status: "needs_review",
      message: "Please review fields because extraction confidence is low."
    };
  }

  if (totals.isSuspicious) {
    return {
      status: "needs_review",
      message:
        "Please review totals. The invoice may include missing discount/charges or ambiguous amounts."
    };
  }

  return { status: "processed", message: undefined };
}

function reconcileTotals(extracted: Awaited<ReturnType<typeof extractInvoiceData>>): {
  isSuspicious: boolean;
} {
  const round2 = (value: number): number => Number(value.toFixed(2));
  const approxEqual = (a: number, b: number, tolerance = 1.5): boolean =>
    Math.abs(round2(a) - round2(b)) <= tolerance;

  const lineItemsTotal = round2(
    extracted.lineItems.reduce((sum, item) => {
      const itemAmount = item.amount > 0 ? item.amount : item.quantity * item.unitPrice;
      return sum + itemAmount;
    }, 0)
  );

  const subtotal = round2(extracted.subTotal);
  const tax = round2(extracted.tax);
  const total = round2(extracted.total);

  // Guard against clearly broken amounts.
  if (subtotal < 0 || tax < 0 || total <= 0) {
    return { isSuspicious: true };
  }

  const subtotalLooksValid =
    extracted.lineItems.length === 0 || approxEqual(subtotal, lineItemsTotal, 2);

  const strictMatch = approxEqual(total, subtotal + tax, 1.5);
  const lineTaxMatch = approxEqual(total, lineItemsTotal + tax, 2.0);

  // Many invoices include shipping/service/other charges not explicitly extracted.
  const unexplainedDelta = round2(total - (subtotal + tax));
  const plausibleExtraCharge =
    unexplainedDelta >= 0 &&
    unexplainedDelta <= Math.max(250, round2(total * 0.35)) &&
    subtotalLooksValid;

  const suspicious = !strictMatch && !lineTaxMatch && !plausibleExtraCharge;
  return { isSuspicious: suspicious };
}

function normalizeMimeType(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized === "image/jpg" || normalized === "image/pjpeg") {
    return "image/jpeg";
  }
  return normalized;
}

function toCsv(extracted: ExtractedInvoice): string {
  const metaRows = [
    ["Vendor", extracted.vendorName],
    ["Invoice Number", extracted.invoiceNumber],
    ["Invoice Date", extracted.invoiceDate],
    ["Due Date", extracted.dueDate ?? ""],
    ["Currency", extracted.currency],
    ["Sub Total", extracted.subTotal.toFixed(2)],
    ["Tax", extracted.tax.toFixed(2)],
    ["Total", extracted.total.toFixed(2)],
    ["Confidence", extracted.confidence.toFixed(2)]
  ];
  const lineItemRows = extracted.lineItems.map((item) => [
    item.description,
    item.quantity.toString(),
    item.unitPrice.toFixed(2),
    item.amount.toFixed(2)
  ]);

  const lines: string[] = [];
  lines.push("Field,Value");
  for (const row of metaRows) {
    lines.push(row.map(csvEscape).join(","));
  }
  lines.push("");
  lines.push("Description,Quantity,Unit Price,Amount");
  for (const row of lineItemRows) {
    lines.push(row.map(csvEscape).join(","));
  }
  return lines.join("\n");
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, "\"\"")}"`;
  }
  return value;
}

function sanitizeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9-_]/g, "_");
}

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception in API process:", error);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection in API process:", reason);
});

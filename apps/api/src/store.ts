import { randomUUID } from "node:crypto";
import type { Invoice, InvoiceStatus } from "./types.js";

const invoices = new Map<string, Invoice>();
const sourcePayloads = new Map<string, string>();

function nowIso(): string {
  return new Date().toISOString();
}

export function createInvoice(params: {
  fileName: string;
  mimeType: string;
  fileBase64: string;
}): Invoice {
  const time = nowIso();
  const id = randomUUID();
  const invoice: Invoice = {
    id,
    status: "queued",
    fileName: params.fileName,
    mimeType: params.mimeType,
    createdAt: time,
    updatedAt: time
  };
  invoices.set(invoice.id, invoice);
  sourcePayloads.set(id, params.fileBase64);
  return invoice;
}

export function getInvoice(id: string): Invoice | undefined {
  return invoices.get(id);
}

export function listInvoices(): Invoice[] {
  return [...invoices.values()].sort((a, b) =>
    a.createdAt < b.createdAt ? 1 : -1
  );
}

export function updateInvoiceStatus(
  id: string,
  status: InvoiceStatus,
  patch: Partial<Invoice> = {}
): Invoice | undefined {
  const current = invoices.get(id);
  if (!current) {
    return undefined;
  }
  const next: Invoice = {
    ...current,
    ...patch,
    status,
    updatedAt: nowIso()
  };
  invoices.set(id, next);
  return next;
}

export function getQueuedInvoiceIds(): string[] {
  return [...invoices.values()]
    .filter((invoice) => invoice.status === "queued")
    .map((invoice) => invoice.id);
}

export function getSourcePayload(invoiceId: string): string | undefined {
  return sourcePayloads.get(invoiceId);
}

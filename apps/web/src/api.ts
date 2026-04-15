import type { ExtractedInvoice, Invoice } from "./types";

const API_BASE_URL = "http://localhost:4000";

export async function createInvoice(payload: {
  fileName: string;
  mimeType: string;
  fileBase64: string;
}): Promise<Invoice> {
  const response = await fetch(`${API_BASE_URL}/invoices`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error("Could not create invoice.");
  }

  return response.json() as Promise<Invoice>;
}

export async function getInvoice(id: string): Promise<Invoice> {
  const response = await fetch(`${API_BASE_URL}/invoices/${id}`);
  if (!response.ok) {
    throw new Error("Could not load invoice.");
  }
  return response.json() as Promise<Invoice>;
}

export async function listInvoices(): Promise<Invoice[]> {
  const response = await fetch(`${API_BASE_URL}/invoices`);
  if (!response.ok) {
    throw new Error("Could not load invoices.");
  }
  return response.json() as Promise<Invoice[]>;
}

export async function retryInvoice(id: string): Promise<Invoice> {
  const response = await fetch(`${API_BASE_URL}/invoices/${id}/retry`, {
    method: "POST"
  });
  if (!response.ok) {
    throw new Error("Could not retry invoice.");
  }
  return response.json() as Promise<Invoice>;
}

export async function getInvoiceSource(id: string): Promise<{ mimeType: string; fileBase64: string }> {
  const response = await fetch(`${API_BASE_URL}/invoices/${id}/source`);
  if (!response.ok) {
    throw new Error("Could not load invoice preview source.");
  }
  return response.json() as Promise<{ mimeType: string; fileBase64: string }>;
}

export async function saveExtractedInvoice(id: string, extracted: ExtractedInvoice): Promise<Invoice> {
  const response = await fetch(`${API_BASE_URL}/invoices/${id}/extracted`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(extracted)
  });
  if (!response.ok) {
    throw new Error("Could not save extracted invoice.");
  }
  return response.json() as Promise<Invoice>;
}

export async function approveInvoice(id: string): Promise<Invoice> {
  const response = await fetch(`${API_BASE_URL}/invoices/${id}/approve`, {
    method: "POST"
  });
  if (!response.ok) {
    throw new Error("Could not approve invoice.");
  }
  return response.json() as Promise<Invoice>;
}

export function getInvoiceCsvDownloadUrl(id: string): string {
  return `${API_BASE_URL}/invoices/${id}/csv`;
}

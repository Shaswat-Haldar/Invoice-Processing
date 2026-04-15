export type InvoiceStatus =
  | "queued"
  | "processing"
  | "needs_review"
  | "processed"
  | "approved"
  | "failed";

export interface InvoiceLineItem {
  description: string;
  quantity: number;
  unitPrice: number;
  amount: number;
}

export interface ExtractedInvoice {
  vendorName: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate?: string;
  currency: string;
  subTotal: number;
  tax: number;
  total: number;
  lineItems: InvoiceLineItem[];
  additionalFields: Record<string, string>;
  confidence: number;
}

export interface Invoice {
  id: string;
  status: InvoiceStatus;
  fileName: string;
  mimeType: string;
  createdAt: string;
  updatedAt: string;
  errorMessage?: string;
  extracted?: ExtractedInvoice;
}

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
  confidence: number;
}

export interface Invoice {
  id: string;
  fileName: string;
  mimeType: string;
  status: InvoiceStatus;
  errorMessage?: string;
  extracted?: ExtractedInvoice;
  createdAt: string;
  updatedAt: string;
}

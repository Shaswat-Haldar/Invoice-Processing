import { useEffect, useMemo, useState } from "react";
import {
  approveInvoice,
  createInvoice,
  getInvoice,
  getInvoiceCsvDownloadUrl,
  getInvoiceSource,
  listInvoices,
  retryInvoice,
  saveExtractedInvoice
} from "./api";
import type { ExtractedInvoice, Invoice } from "./types";

const MAX_FILE_SIZE_BYTES = 8 * 1024 * 1024;
const LOCAL_INVOICES_KEY = "invoice-processor.invoices";
const LOCAL_SELECTED_KEY = "invoice-processor.selected-id";
const LOCAL_THEME_KEY = "invoice-processor.theme";
type ThemeMode = "light" | "dark";

export default function App() {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [selectedId, setSelectedId] = useState<string>("");
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [selectedInvoice, setSelectedInvoice] = useState<Invoice | null>(null);
  const [theme, setTheme] = useState<ThemeMode>("light");
  const [previewDataUrl, setPreviewDataUrl] = useState("");
  const [previewMimeType, setPreviewMimeType] = useState("");
  const [isSavingEdits, setIsSavingEdits] = useState(false);
  const [isApproving, setIsApproving] = useState(false);
  const [draftExtracted, setDraftExtracted] = useState<ExtractedInvoice | null>(null);

  const selectedStatus = selectedInvoice?.status;
  const isProcessing = selectedStatus === "queued" || selectedStatus === "processing";

  useEffect(() => {
    const cachedTheme = readTheme();
    setTheme(cachedTheme);
    applyTheme(cachedTheme);

    const cachedInvoices = readCachedInvoices();
    const cachedSelectedId = window.localStorage.getItem(LOCAL_SELECTED_KEY) ?? "";
    if (cachedInvoices.length > 0) {
      setInvoices(cachedInvoices);
    }
    if (cachedSelectedId) {
      setSelectedId(cachedSelectedId);
      const selected = cachedInvoices.find((invoice) => invoice.id === cachedSelectedId);
      if (selected) {
        setSelectedInvoice(selected);
      }
    }
    void refreshInvoices();
  }, []);

  useEffect(() => {
    if (!selectedId) {
      return;
    }

    let timerId: number | undefined;

    const poll = async () => {
      try {
        const invoice = await getInvoice(selectedId);
        setSelectedInvoice(invoice);
        upsertCachedInvoice(invoice);
        if (invoice.status === "queued" || invoice.status === "processing") {
          timerId = window.setTimeout(poll, 1200);
        } else {
          void refreshInvoices();
        }
      } catch (pollError) {
        setError(pollError instanceof Error ? pollError.message : "Polling failed.");
      }
    };

    void poll();
    return () => {
      if (timerId) {
        window.clearTimeout(timerId);
      }
    };
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId) {
      setPreviewDataUrl("");
      setPreviewMimeType("");
      return;
    }
    void loadPreviewSource(selectedId);
  }, [selectedId]);

  useEffect(() => {
    setDraftExtracted(selectedInvoice?.extracted ? deepCloneExtracted(selectedInvoice.extracted) : null);
  }, [selectedInvoice?.id, selectedInvoice?.updatedAt]);

  useEffect(() => {
    window.localStorage.setItem(LOCAL_SELECTED_KEY, selectedId);
  }, [selectedId]);

  useEffect(() => {
    applyTheme(theme);
    window.localStorage.setItem(LOCAL_THEME_KEY, theme);
  }, [theme]);

  const canSubmit = useMemo(() => {
    return !!selectedFile && !isSubmitting;
  }, [selectedFile, isSubmitting]);

  async function refreshInvoices(): Promise<void> {
    try {
      const data = await listInvoices();
      setInvoices(data);
      window.localStorage.setItem(LOCAL_INVOICES_KEY, JSON.stringify(data));
    } catch (refreshError) {
      const cached = readCachedInvoices();
      if (cached.length > 0) {
        setInvoices(cached);
      } else {
        setError(refreshError instanceof Error ? refreshError.message : "Could not load invoices.");
      }
    }
  }

  async function onSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError("");

    if (!selectedFile) {
      setError("Please select an invoice file.");
      return;
    }
    if (!isSupportedMime(selectedFile.type)) {
      setError("Only PDF and image files (png, jpg, jpeg, webp) are allowed.");
      return;
    }
    if (selectedFile.size > MAX_FILE_SIZE_BYTES) {
      setError("File is too large. Maximum supported size is 8 MB.");
      return;
    }

    setIsSubmitting(true);
    try {
      const fileBase64 = await fileToBase64(selectedFile);
      const invoice = await createInvoice({
        fileName: selectedFile.name,
        mimeType: normalizeMimeType(selectedFile.type),
        fileBase64
      });
      setSelectedId(invoice.id);
      setSelectedInvoice(invoice);
      setSelectedFile(null);
      const fileInput = document.getElementById("invoice-file-input") as HTMLInputElement | null;
      if (fileInput) {
        fileInput.value = "";
      }
      await refreshInvoices();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Upload failed.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function onRetryCurrentInvoice(): Promise<void> {
    if (!selectedInvoice || isRetrying || isProcessing) {
      return;
    }
    setError("");
    setIsRetrying(true);
    try {
      const retried = await retryInvoice(selectedInvoice.id);
      setSelectedInvoice(retried);
      setSelectedId(retried.id);
      upsertCachedInvoice(retried);
      await refreshInvoices();
    } catch (retryError) {
      setError(retryError instanceof Error ? retryError.message : "Retry failed.");
    } finally {
      setIsRetrying(false);
    }
  }

  async function loadPreviewSource(invoiceId: string): Promise<void> {
    try {
      const source = await getInvoiceSource(invoiceId);
      setPreviewMimeType(source.mimeType);
      setPreviewDataUrl(`data:${source.mimeType};base64,${source.fileBase64}`);
    } catch (previewError) {
      setPreviewDataUrl("");
      setPreviewMimeType("");
      setError(previewError instanceof Error ? previewError.message : "Could not load preview.");
    }
  }

  async function onSaveEdits(): Promise<void> {
    if (!selectedInvoice || !draftExtracted) {
      return;
    }
    setIsSavingEdits(true);
    setError("");
    try {
      const updated = await saveExtractedInvoice(selectedInvoice.id, normalizeExtractedForSave(draftExtracted));
      setSelectedInvoice(updated);
      upsertCachedInvoice(updated);
      await refreshInvoices();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save changes.");
    } finally {
      setIsSavingEdits(false);
    }
  }

  async function onApproveInvoice(): Promise<void> {
    if (!selectedInvoice) {
      return;
    }
    setIsApproving(true);
    setError("");
    try {
      const approved = await approveInvoice(selectedInvoice.id);
      setSelectedInvoice(approved);
      upsertCachedInvoice(approved);
      await refreshInvoices();
    } catch (approveError) {
      setError(approveError instanceof Error ? approveError.message : "Could not approve invoice.");
    } finally {
      setIsApproving(false);
    }
  }

  function updateDraftField<K extends keyof ExtractedInvoice>(key: K, value: ExtractedInvoice[K]): void {
    setDraftExtracted((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  function updateLineItem(
    index: number,
    key: keyof ExtractedInvoice["lineItems"][number],
    value: string | number
  ): void {
    setDraftExtracted((prev) => {
      if (!prev) {
        return prev;
      }
      const nextItems = prev.lineItems.map((item, itemIndex) =>
        itemIndex === index ? { ...item, [key]: value } : item
      );
      return { ...prev, lineItems: nextItems };
    });
  }

  return (
    <div className="min-h-screen p-4 md:p-8">
      <div className="mx-auto max-w-7xl animate-fade-in">
        <header className="mb-6 rounded-2xl border border-slate-200 bg-white/70 p-5 shadow-sm backdrop-blur dark:border-slate-800 dark:bg-slate-900/70">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <h1 className="text-2xl font-semibold md:text-3xl">Invoice Processing Dashboard</h1>
              <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
                Upload PDF or image invoices, extract structured data, and retry processing in one
                click.
              </p>
            </div>
            <button
              className="rounded-xl border border-slate-300 bg-slate-100 px-4 py-2 text-sm font-medium transition hover:scale-[1.02] hover:bg-slate-200 dark:border-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700"
              onClick={() => setTheme((prev) => (prev === "light" ? "dark" : "light"))}
            >
              {theme === "light" ? "Switch to Dark" : "Switch to Light"}
            </button>
          </div>
        </header>

        <main className="grid grid-cols-1 gap-4 lg:grid-cols-4">
          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:shadow-md dark:border-slate-800 dark:bg-slate-900">
            <h2 className="text-lg font-semibold">Upload Invoice</h2>
            <form onSubmit={onSubmit} className="mt-4 space-y-3">
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-200">
                Select File
              </label>
              <input
                id="invoice-file-input"
                type="file"
                className="w-full rounded-lg border border-slate-300 bg-white p-2 text-sm dark:border-slate-700 dark:bg-slate-950"
                accept=".pdf,image/png,image/jpeg,image/jpg,image/webp"
                onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)}
              />
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Supported: PDF, PNG, JPG, JPEG, WEBP (max 8 MB)
                {selectedFile ? ` | Selected: ${selectedFile.name}` : ""}
              </p>
              <button
                className="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:scale-[1.01] hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!canSubmit}
              >
                {isSubmitting ? "Submitting..." : "Upload & Process"}
              </button>
            </form>
            {error ? <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p> : null}
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:shadow-md dark:border-slate-800 dark:bg-slate-900">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-lg font-semibold">Invoices</h2>
              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                {invoices.length}
              </span>
            </div>

            {invoices.length === 0 ? (
              <p className="text-sm text-slate-500 dark:text-slate-400">No invoices yet.</p>
            ) : (
              <ul className="space-y-2">
                {invoices.map((invoice) => (
                  <li key={invoice.id}>
                    <button
                      className={`w-full rounded-xl border p-3 text-left transition ${
                        selectedId === invoice.id
                          ? "border-blue-500 bg-blue-50 dark:border-blue-400 dark:bg-blue-950/40"
                          : "border-slate-200 bg-slate-50 hover:border-slate-300 dark:border-slate-700 dark:bg-slate-800/40"
                      }`}
                      onClick={() => setSelectedId(invoice.id)}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-medium">{invoice.fileName}</span>
                        <span className={statusPillClass(invoice.status)}>{invoice.status}</span>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:shadow-md dark:border-slate-800 dark:bg-slate-900 lg:col-span-2">
            <h2 className="text-lg font-semibold">Document Preview</h2>
            <div className="mt-4 overflow-hidden rounded-xl border border-slate-200 bg-slate-50 p-2 dark:border-slate-700 dark:bg-slate-950">
              {previewDataUrl ? (
                previewMimeType === "application/pdf" ? (
                  <iframe
                    src={previewDataUrl}
                    title="Invoice PDF Preview"
                    className="h-[640px] w-full rounded-lg bg-white dark:bg-slate-900"
                  />
                ) : (
                  <img
                    src={previewDataUrl}
                    alt="Invoice Preview"
                    className="max-h-[640px] w-full rounded-lg object-contain"
                  />
                )
              ) : (
                <p className="p-4 text-sm text-slate-500 dark:text-slate-400">
                  Select an invoice to preview.
                </p>
              )}
            </div>
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:shadow-md dark:border-slate-800 dark:bg-slate-900 lg:col-span-4">
            <h2 className="text-lg font-semibold">Extracted Result</h2>
            {!selectedInvoice ? (
              <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">
                Select or upload an invoice.
              </p>
            ) : (
              <div className="mt-4 animate-slide-up space-y-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold">Status:</span>
                  <span className={statusPillClass(selectedInvoice.status)}>{selectedInvoice.status}</span>
                  {isProcessing ? (
                    <span className="rounded-full bg-amber-100 px-3 py-1 text-xs text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                      Processing...
                    </span>
                  ) : null}
                </div>

                {selectedInvoice.errorMessage ? (
                  <p
                    className={`rounded-lg border p-3 text-sm ${
                      selectedInvoice.status === "failed"
                        ? "border-red-300 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
                        : "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300"
                    }`}
                  >
                    {selectedInvoice.errorMessage}
                  </p>
                ) : null}

                {(selectedInvoice.status === "failed" || selectedInvoice.status === "needs_review") && (
                  <button
                    className="rounded-lg border border-slate-300 bg-slate-100 px-4 py-2 text-sm font-medium transition hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700"
                    disabled={isRetrying || isProcessing}
                    onClick={() => void onRetryCurrentInvoice()}
                  >
                    {isRetrying ? "Retrying..." : "Retry Processing"}
                  </button>
                )}

                {draftExtracted ? (
                  <>
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                      <EditableText
                        label="Vendor"
                        value={draftExtracted.vendorName}
                        onChange={(value) => updateDraftField("vendorName", value)}
                      />
                      <EditableText
                        label="Invoice #"
                        value={draftExtracted.invoiceNumber}
                        onChange={(value) => updateDraftField("invoiceNumber", value)}
                      />
                      <EditableText
                        label="Invoice Date"
                        value={draftExtracted.invoiceDate}
                        onChange={(value) => updateDraftField("invoiceDate", value)}
                      />
                      <EditableText
                        label="Due Date"
                        value={draftExtracted.dueDate ?? ""}
                        onChange={(value) => updateDraftField("dueDate", value || undefined)}
                      />
                      <EditableText
                        label="Currency"
                        value={draftExtracted.currency}
                        onChange={(value) => updateDraftField("currency", value.toUpperCase())}
                      />
                      <Info
                        label="Confidence"
                        value={`${Math.round(draftExtracted.confidence * 100)}%`}
                      />
                    </div>

                    <div className="overflow-hidden rounded-xl border border-slate-200 dark:border-slate-700">
                      <table className="min-w-full divide-y divide-slate-200 text-sm dark:divide-slate-700">
                        <thead className="bg-slate-50 dark:bg-slate-800/50">
                          <tr>
                            <th className="px-3 py-2 text-left font-semibold">Description</th>
                            <th className="px-3 py-2 text-right font-semibold">Qty</th>
                            <th className="px-3 py-2 text-right font-semibold">Unit Price</th>
                            <th className="px-3 py-2 text-right font-semibold">Amount</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-200 dark:divide-slate-700">
                          {draftExtracted.lineItems.length > 0 ? (
                            draftExtracted.lineItems.map((item, index) => (
                              <tr key={`${item.description}-${index}`}>
                                <td className="px-3 py-2">
                                  <input
                                    className="w-full rounded border border-slate-300 bg-white p-1 dark:border-slate-700 dark:bg-slate-900"
                                    value={item.description}
                                    onChange={(event) =>
                                      updateLineItem(index, "description", event.target.value)
                                    }
                                  />
                                </td>
                                <td className="px-3 py-2">
                                  <input
                                    type="number"
                                    className="w-full rounded border border-slate-300 bg-white p-1 text-right dark:border-slate-700 dark:bg-slate-900"
                                    value={item.quantity}
                                    onChange={(event) =>
                                      updateLineItem(index, "quantity", toNumber(event.target.value))
                                    }
                                  />
                                </td>
                                <td className="px-3 py-2">
                                  <input
                                    type="number"
                                    className="w-full rounded border border-slate-300 bg-white p-1 text-right dark:border-slate-700 dark:bg-slate-900"
                                    value={item.unitPrice}
                                    onChange={(event) =>
                                      updateLineItem(index, "unitPrice", toNumber(event.target.value))
                                    }
                                  />
                                </td>
                                <td className="px-3 py-2">
                                  <input
                                    type="number"
                                    className="w-full rounded border border-slate-300 bg-white p-1 text-right dark:border-slate-700 dark:bg-slate-900"
                                    value={item.amount}
                                    onChange={(event) =>
                                      updateLineItem(index, "amount", toNumber(event.target.value))
                                    }
                                  />
                                </td>
                              </tr>
                            ))
                          ) : (
                            <tr>
                              <td className="px-3 py-3 text-slate-500 dark:text-slate-400" colSpan={4}>
                                No line items extracted.
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>

                    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                      <EditableNumber
                        label="Sub Total"
                        value={draftExtracted.subTotal}
                        onChange={(value) => updateDraftField("subTotal", value)}
                        currency={draftExtracted.currency}
                      />
                      <EditableNumber
                        label="Tax"
                        value={draftExtracted.tax}
                        onChange={(value) => updateDraftField("tax", value)}
                        currency={draftExtracted.currency}
                      />
                      <EditableNumber
                        label="Total"
                        value={draftExtracted.total}
                        onChange={(value) => updateDraftField("total", value)}
                        currency={draftExtracted.currency}
                      />
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <button
                        className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:opacity-50"
                        disabled={isSavingEdits}
                        onClick={() => void onSaveEdits()}
                      >
                        {isSavingEdits ? "Saving..." : "Save Changes"}
                      </button>
                      <button
                        className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50"
                        disabled={isApproving || !selectedInvoice.extracted}
                        onClick={() => void onApproveInvoice()}
                      >
                        {isApproving ? "Approving..." : "Approve Invoice"}
                      </button>
                      <a
                        className="rounded-lg border border-slate-300 bg-slate-100 px-4 py-2 text-sm font-medium transition hover:bg-slate-200 dark:border-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700"
                        href={getInvoiceCsvDownloadUrl(selectedInvoice.id)}
                        download
                      >
                        Download CSV
                      </a>
                    </div>
                  </>
                ) : null}
              </div>
            )}
          </section>
        </main>
      </div>
    </div>
  );
}

function Info(props: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800/50">
      <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">{props.label}</p>
      <p className="mt-1 text-sm font-semibold">{props.value}</p>
    </div>
  );
}

function readCachedInvoices(): Invoice[] {
  try {
    const raw = window.localStorage.getItem(LOCAL_INVOICES_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as Invoice[]) : [];
  } catch {
    return [];
  }
}

function upsertCachedInvoice(invoice: Invoice): void {
  const current = readCachedInvoices();
  const filtered = current.filter((item) => item.id !== invoice.id);
  const next = [invoice, ...filtered];
  window.localStorage.setItem(LOCAL_INVOICES_KEY, JSON.stringify(next));
}

function statusPillClass(status: Invoice["status"]): string {
  const base = "rounded-full px-3 py-1 text-xs capitalize";
  if (status === "processed") {
    return `${base} bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300`;
  }
  if (status === "approved") {
    return `${base} bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300`;
  }
  if (status === "failed") {
    return `${base} bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300`;
  }
  if (status === "needs_review") {
    return `${base} bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300`;
  }
  return `${base} bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300`;
}

function formatMoney(value: number, currency?: string): string {
  const safeCurrency = currency && currency.length === 3 ? currency : "USD";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: safeCurrency
    }).format(value);
  } catch {
    return `${safeCurrency} ${value.toFixed(2)}`;
  }
}

function EditableText(props: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800/50">
      <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">{props.label}</p>
      <input
        className="mt-1 w-full rounded border border-slate-300 bg-white p-1 text-sm font-semibold dark:border-slate-700 dark:bg-slate-900"
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </div>
  );
}

function EditableNumber(props: {
  label: string;
  value: number;
  currency?: string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800/50">
      <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">{props.label}</p>
      <input
        type="number"
        className="mt-1 w-full rounded border border-slate-300 bg-white p-1 text-sm font-semibold dark:border-slate-700 dark:bg-slate-900"
        value={props.value}
        onChange={(event) => props.onChange(toNumber(event.target.value))}
      />
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
        {formatMoney(props.value, props.currency)}
      </p>
    </div>
  );
}

function isSupportedMime(mimeType: string): boolean {
  const normalized = normalizeMimeType(mimeType);
  return (
    normalized === "application/pdf" ||
    normalized === "image/png" ||
    normalized === "image/jpeg" ||
    normalized === "image/webp"
  );
}

function normalizeMimeType(mimeType: string): string {
  if (mimeType === "image/jpg") {
    return "image/jpeg";
  }
  return mimeType;
}

async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return window.btoa(binary);
}

function readTheme(): ThemeMode {
  const stored = window.localStorage.getItem(LOCAL_THEME_KEY);
  if (stored === "light" || stored === "dark") {
    return stored;
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme: ThemeMode): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

function deepCloneExtracted(extracted: ExtractedInvoice): ExtractedInvoice {
  return {
    ...extracted,
    lineItems: extracted.lineItems.map((item) => ({ ...item }))
  };
}

function normalizeExtractedForSave(extracted: ExtractedInvoice): ExtractedInvoice {
  return {
    ...extracted,
    currency: extracted.currency.toUpperCase().slice(0, 3) || "USD",
    subTotal: toNumber(extracted.subTotal),
    tax: toNumber(extracted.tax),
    total: toNumber(extracted.total),
    confidence: Math.min(1, Math.max(0, toNumber(extracted.confidence))),
    lineItems: extracted.lineItems.map((item) => ({
      description: item.description.trim() || "Item",
      quantity: toNumber(item.quantity),
      unitPrice: toNumber(item.unitPrice),
      amount: toNumber(item.amount)
    }))
  };
}

function toNumber(value: string | number): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

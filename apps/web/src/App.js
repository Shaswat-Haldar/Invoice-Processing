import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useMemo, useState } from "react";
import { approveInvoice, createInvoice, getInvoice, getInvoiceCsvDownloadUrl, getInvoiceSource, listInvoices, retryInvoice, saveExtractedInvoice } from "./api";
const MAX_FILE_SIZE_BYTES = 8 * 1024 * 1024;
const LOCAL_INVOICES_KEY = "invoice-processor.invoices";
const LOCAL_SELECTED_KEY = "invoice-processor.selected-id";
const LOCAL_THEME_KEY = "invoice-processor.theme";
export default function App() {
    const [selectedFile, setSelectedFile] = useState(null);
    const [error, setError] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [isRetrying, setIsRetrying] = useState(false);
    const [selectedId, setSelectedId] = useState("");
    const [invoices, setInvoices] = useState([]);
    const [selectedInvoice, setSelectedInvoice] = useState(null);
    const [theme, setTheme] = useState("light");
    const [previewDataUrl, setPreviewDataUrl] = useState("");
    const [previewMimeType, setPreviewMimeType] = useState("");
    const [isSavingEdits, setIsSavingEdits] = useState(false);
    const [isApproving, setIsApproving] = useState(false);
    const [draftExtracted, setDraftExtracted] = useState(null);
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
        let timerId;
        const poll = async () => {
            try {
                const invoice = await getInvoice(selectedId);
                setSelectedInvoice(invoice);
                upsertCachedInvoice(invoice);
                if (invoice.status === "queued" || invoice.status === "processing") {
                    timerId = window.setTimeout(poll, 1200);
                }
                else {
                    void refreshInvoices();
                }
            }
            catch (pollError) {
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
    async function refreshInvoices() {
        try {
            const data = await listInvoices();
            setInvoices(data);
            window.localStorage.setItem(LOCAL_INVOICES_KEY, JSON.stringify(data));
        }
        catch (refreshError) {
            const cached = readCachedInvoices();
            if (cached.length > 0) {
                setInvoices(cached);
            }
            else {
                setError(refreshError instanceof Error ? refreshError.message : "Could not load invoices.");
            }
        }
    }
    async function onSubmit(event) {
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
            const fileInput = document.getElementById("invoice-file-input");
            if (fileInput) {
                fileInput.value = "";
            }
            await refreshInvoices();
        }
        catch (submitError) {
            setError(submitError instanceof Error ? submitError.message : "Upload failed.");
        }
        finally {
            setIsSubmitting(false);
        }
    }
    async function onRetryCurrentInvoice() {
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
        }
        catch (retryError) {
            setError(retryError instanceof Error ? retryError.message : "Retry failed.");
        }
        finally {
            setIsRetrying(false);
        }
    }
    async function loadPreviewSource(invoiceId) {
        try {
            const source = await getInvoiceSource(invoiceId);
            setPreviewMimeType(source.mimeType);
            setPreviewDataUrl(`data:${source.mimeType};base64,${source.fileBase64}`);
        }
        catch (previewError) {
            setPreviewDataUrl("");
            setPreviewMimeType("");
            setError(previewError instanceof Error ? previewError.message : "Could not load preview.");
        }
    }
    async function onSaveEdits() {
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
        }
        catch (saveError) {
            setError(saveError instanceof Error ? saveError.message : "Could not save changes.");
        }
        finally {
            setIsSavingEdits(false);
        }
    }
    async function onApproveInvoice() {
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
        }
        catch (approveError) {
            setError(approveError instanceof Error ? approveError.message : "Could not approve invoice.");
        }
        finally {
            setIsApproving(false);
        }
    }
    function updateDraftField(key, value) {
        setDraftExtracted((prev) => (prev ? { ...prev, [key]: value } : prev));
    }
    function updateLineItem(index, key, value) {
        setDraftExtracted((prev) => {
            if (!prev) {
                return prev;
            }
            const nextItems = prev.lineItems.map((item, itemIndex) => itemIndex === index ? { ...item, [key]: value } : item);
            return { ...prev, lineItems: nextItems };
        });
    }
    return (_jsx("div", { className: "min-h-screen p-4 md:p-8", children: _jsxs("div", { className: "mx-auto max-w-7xl animate-fade-in", children: [_jsx("header", { className: "mb-6 rounded-2xl border border-slate-200 bg-white/70 p-5 shadow-sm backdrop-blur dark:border-slate-800 dark:bg-slate-900/70", children: _jsxs("div", { className: "flex flex-col gap-4 md:flex-row md:items-center md:justify-between", children: [_jsxs("div", { children: [_jsx("h1", { className: "text-2xl font-semibold md:text-3xl", children: "Invoice Processing Dashboard" }), _jsx("p", { className: "mt-1 text-sm text-slate-600 dark:text-slate-300", children: "Upload PDF or image invoices, extract structured data, and retry processing in one click." })] }), _jsx("button", { className: "rounded-xl border border-slate-300 bg-slate-100 px-4 py-2 text-sm font-medium transition hover:scale-[1.02] hover:bg-slate-200 dark:border-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700", onClick: () => setTheme((prev) => (prev === "light" ? "dark" : "light")), children: theme === "light" ? "Switch to Dark" : "Switch to Light" })] }) }), _jsxs("main", { className: "grid grid-cols-1 gap-4 lg:grid-cols-4", children: [_jsxs("section", { className: "rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:shadow-md dark:border-slate-800 dark:bg-slate-900", children: [_jsx("h2", { className: "text-lg font-semibold", children: "Upload Invoice" }), _jsxs("form", { onSubmit: onSubmit, className: "mt-4 space-y-3", children: [_jsx("label", { className: "block text-sm font-medium text-slate-700 dark:text-slate-200", children: "Select File" }), _jsx("input", { id: "invoice-file-input", type: "file", className: "w-full rounded-lg border border-slate-300 bg-white p-2 text-sm dark:border-slate-700 dark:bg-slate-950", accept: ".pdf,image/png,image/jpeg,image/jpg,image/webp", onChange: (event) => setSelectedFile(event.target.files?.[0] ?? null) }), _jsxs("p", { className: "text-xs text-slate-500 dark:text-slate-400", children: ["Supported: PDF, PNG, JPG, JPEG, WEBP (max 8 MB)", selectedFile ? ` | Selected: ${selectedFile.name}` : ""] }), _jsx("button", { className: "w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:scale-[1.01] hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50", disabled: !canSubmit, children: isSubmitting ? "Submitting..." : "Upload & Process" })] }), error ? _jsx("p", { className: "mt-3 text-sm text-red-600 dark:text-red-400", children: error }) : null] }), _jsxs("section", { className: "rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:shadow-md dark:border-slate-800 dark:bg-slate-900", children: [_jsxs("div", { className: "mb-3 flex items-center justify-between", children: [_jsx("h2", { className: "text-lg font-semibold", children: "Invoices" }), _jsx("span", { className: "rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300", children: invoices.length })] }), invoices.length === 0 ? (_jsx("p", { className: "text-sm text-slate-500 dark:text-slate-400", children: "No invoices yet." })) : (_jsx("ul", { className: "space-y-2", children: invoices.map((invoice) => (_jsx("li", { children: _jsx("button", { className: `w-full rounded-xl border p-3 text-left transition ${selectedId === invoice.id
                                                ? "border-blue-500 bg-blue-50 dark:border-blue-400 dark:bg-blue-950/40"
                                                : "border-slate-200 bg-slate-50 hover:border-slate-300 dark:border-slate-700 dark:bg-slate-800/40"}`, onClick: () => setSelectedId(invoice.id), children: _jsxs("div", { className: "flex items-center justify-between gap-2", children: [_jsx("span", { className: "truncate text-sm font-medium", children: invoice.fileName }), _jsx("span", { className: statusPillClass(invoice.status), children: invoice.status })] }) }) }, invoice.id))) }))] }), _jsxs("section", { className: "rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:shadow-md dark:border-slate-800 dark:bg-slate-900 lg:col-span-2", children: [_jsx("h2", { className: "text-lg font-semibold", children: "Document Preview" }), _jsx("div", { className: "mt-4 overflow-hidden rounded-xl border border-slate-200 bg-slate-50 p-2 dark:border-slate-700 dark:bg-slate-950", children: previewDataUrl ? (previewMimeType === "application/pdf" ? (_jsx("iframe", { src: previewDataUrl, title: "Invoice PDF Preview", className: "h-[640px] w-full rounded-lg bg-white dark:bg-slate-900" })) : (_jsx("img", { src: previewDataUrl, alt: "Invoice Preview", className: "max-h-[640px] w-full rounded-lg object-contain" }))) : (_jsx("p", { className: "p-4 text-sm text-slate-500 dark:text-slate-400", children: "Select an invoice to preview." })) })] }), _jsxs("section", { className: "rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:shadow-md dark:border-slate-800 dark:bg-slate-900 lg:col-span-4", children: [_jsx("h2", { className: "text-lg font-semibold", children: "Extracted Result" }), !selectedInvoice ? (_jsx("p", { className: "mt-3 text-sm text-slate-500 dark:text-slate-400", children: "Select or upload an invoice." })) : (_jsxs("div", { className: "mt-4 animate-slide-up space-y-4", children: [_jsxs("div", { className: "flex flex-wrap items-center gap-2", children: [_jsx("span", { className: "text-sm font-semibold", children: "Status:" }), _jsx("span", { className: statusPillClass(selectedInvoice.status), children: selectedInvoice.status }), isProcessing ? (_jsx("span", { className: "rounded-full bg-amber-100 px-3 py-1 text-xs text-amber-700 dark:bg-amber-900/40 dark:text-amber-300", children: "Processing..." })) : null] }), selectedInvoice.errorMessage ? (_jsx("p", { className: `rounded-lg border p-3 text-sm ${selectedInvoice.status === "failed"
                                                ? "border-red-300 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
                                                : "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300"}`, children: selectedInvoice.errorMessage })) : null, (selectedInvoice.status === "failed" || selectedInvoice.status === "needs_review") && (_jsx("button", { className: "rounded-lg border border-slate-300 bg-slate-100 px-4 py-2 text-sm font-medium transition hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700", disabled: isRetrying || isProcessing, onClick: () => void onRetryCurrentInvoice(), children: isRetrying ? "Retrying..." : "Retry Processing" })), draftExtracted ? (_jsxs(_Fragment, { children: [_jsxs("div", { className: "grid grid-cols-1 gap-3 md:grid-cols-3", children: [_jsx(EditableText, { label: "Vendor", value: draftExtracted.vendorName, onChange: (value) => updateDraftField("vendorName", value) }), _jsx(EditableText, { label: "Invoice #", value: draftExtracted.invoiceNumber, onChange: (value) => updateDraftField("invoiceNumber", value) }), _jsx(EditableText, { label: "Invoice Date", value: draftExtracted.invoiceDate, onChange: (value) => updateDraftField("invoiceDate", value) }), _jsx(EditableText, { label: "Due Date", value: draftExtracted.dueDate ?? "", onChange: (value) => updateDraftField("dueDate", value || undefined) }), _jsx(EditableText, { label: "Currency", value: draftExtracted.currency, onChange: (value) => updateDraftField("currency", value.toUpperCase()) }), _jsx(Info, { label: "Confidence", value: `${Math.round(draftExtracted.confidence * 100)}%` })] }), _jsx("div", { className: "overflow-hidden rounded-xl border border-slate-200 dark:border-slate-700", children: _jsxs("table", { className: "min-w-full divide-y divide-slate-200 text-sm dark:divide-slate-700", children: [_jsx("thead", { className: "bg-slate-50 dark:bg-slate-800/50", children: _jsxs("tr", { children: [_jsx("th", { className: "px-3 py-2 text-left font-semibold", children: "Description" }), _jsx("th", { className: "px-3 py-2 text-right font-semibold", children: "Qty" }), _jsx("th", { className: "px-3 py-2 text-right font-semibold", children: "Unit Price" }), _jsx("th", { className: "px-3 py-2 text-right font-semibold", children: "Amount" })] }) }), _jsx("tbody", { className: "divide-y divide-slate-200 dark:divide-slate-700", children: draftExtracted.lineItems.length > 0 ? (draftExtracted.lineItems.map((item, index) => (_jsxs("tr", { children: [_jsx("td", { className: "px-3 py-2", children: _jsx("input", { className: "w-full rounded border border-slate-300 bg-white p-1 dark:border-slate-700 dark:bg-slate-900", value: item.description, onChange: (event) => updateLineItem(index, "description", event.target.value) }) }), _jsx("td", { className: "px-3 py-2", children: _jsx("input", { type: "number", className: "w-full rounded border border-slate-300 bg-white p-1 text-right dark:border-slate-700 dark:bg-slate-900", value: item.quantity, onChange: (event) => updateLineItem(index, "quantity", toNumber(event.target.value)) }) }), _jsx("td", { className: "px-3 py-2", children: _jsx("input", { type: "number", className: "w-full rounded border border-slate-300 bg-white p-1 text-right dark:border-slate-700 dark:bg-slate-900", value: item.unitPrice, onChange: (event) => updateLineItem(index, "unitPrice", toNumber(event.target.value)) }) }), _jsx("td", { className: "px-3 py-2", children: _jsx("input", { type: "number", className: "w-full rounded border border-slate-300 bg-white p-1 text-right dark:border-slate-700 dark:bg-slate-900", value: item.amount, onChange: (event) => updateLineItem(index, "amount", toNumber(event.target.value)) }) })] }, `${item.description}-${index}`)))) : (_jsx("tr", { children: _jsx("td", { className: "px-3 py-3 text-slate-500 dark:text-slate-400", colSpan: 4, children: "No line items extracted." }) })) })] }) }), _jsxs("div", { className: "grid grid-cols-1 gap-3 md:grid-cols-3", children: [_jsx(EditableNumber, { label: "Sub Total", value: draftExtracted.subTotal, onChange: (value) => updateDraftField("subTotal", value), currency: draftExtracted.currency }), _jsx(EditableNumber, { label: "Tax", value: draftExtracted.tax, onChange: (value) => updateDraftField("tax", value), currency: draftExtracted.currency }), _jsx(EditableNumber, { label: "Total", value: draftExtracted.total, onChange: (value) => updateDraftField("total", value), currency: draftExtracted.currency })] }), _jsxs("div", { className: "flex flex-wrap gap-2", children: [_jsx("button", { className: "rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:opacity-50", disabled: isSavingEdits, onClick: () => void onSaveEdits(), children: isSavingEdits ? "Saving..." : "Save Changes" }), _jsx("button", { className: "rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50", disabled: isApproving || !selectedInvoice.extracted, onClick: () => void onApproveInvoice(), children: isApproving ? "Approving..." : "Approve Invoice" }), _jsx("a", { className: "rounded-lg border border-slate-300 bg-slate-100 px-4 py-2 text-sm font-medium transition hover:bg-slate-200 dark:border-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700", href: getInvoiceCsvDownloadUrl(selectedInvoice.id), download: true, children: "Download CSV" })] })] })) : null] }))] })] })] }) }));
}
function Info(props) {
    return (_jsxs("div", { className: "rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800/50", children: [_jsx("p", { className: "text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400", children: props.label }), _jsx("p", { className: "mt-1 text-sm font-semibold", children: props.value })] }));
}
function readCachedInvoices() {
    try {
        const raw = window.localStorage.getItem(LOCAL_INVOICES_KEY);
        if (!raw) {
            return [];
        }
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    }
    catch {
        return [];
    }
}
function upsertCachedInvoice(invoice) {
    const current = readCachedInvoices();
    const filtered = current.filter((item) => item.id !== invoice.id);
    const next = [invoice, ...filtered];
    window.localStorage.setItem(LOCAL_INVOICES_KEY, JSON.stringify(next));
}
function statusPillClass(status) {
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
function formatMoney(value, currency) {
    const safeCurrency = currency && currency.length === 3 ? currency : "USD";
    try {
        return new Intl.NumberFormat(undefined, {
            style: "currency",
            currency: safeCurrency
        }).format(value);
    }
    catch {
        return `${safeCurrency} ${value.toFixed(2)}`;
    }
}
function EditableText(props) {
    return (_jsxs("div", { className: "rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800/50", children: [_jsx("p", { className: "text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400", children: props.label }), _jsx("input", { className: "mt-1 w-full rounded border border-slate-300 bg-white p-1 text-sm font-semibold dark:border-slate-700 dark:bg-slate-900", value: props.value, onChange: (event) => props.onChange(event.target.value) })] }));
}
function EditableNumber(props) {
    return (_jsxs("div", { className: "rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800/50", children: [_jsx("p", { className: "text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400", children: props.label }), _jsx("input", { type: "number", className: "mt-1 w-full rounded border border-slate-300 bg-white p-1 text-sm font-semibold dark:border-slate-700 dark:bg-slate-900", value: props.value, onChange: (event) => props.onChange(toNumber(event.target.value)) }), _jsx("p", { className: "mt-1 text-xs text-slate-500 dark:text-slate-400", children: formatMoney(props.value, props.currency) })] }));
}
function isSupportedMime(mimeType) {
    const normalized = normalizeMimeType(mimeType);
    return (normalized === "application/pdf" ||
        normalized === "image/png" ||
        normalized === "image/jpeg" ||
        normalized === "image/webp");
}
function normalizeMimeType(mimeType) {
    if (mimeType === "image/jpg") {
        return "image/jpeg";
    }
    return mimeType;
}
async function fileToBase64(file) {
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
function readTheme() {
    const stored = window.localStorage.getItem(LOCAL_THEME_KEY);
    if (stored === "light" || stored === "dark") {
        return stored;
    }
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
function applyTheme(theme) {
    document.documentElement.classList.toggle("dark", theme === "dark");
}
function deepCloneExtracted(extracted) {
    return {
        ...extracted,
        lineItems: extracted.lineItems.map((item) => ({ ...item }))
    };
}
function normalizeExtractedForSave(extracted) {
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
function toNumber(value) {
    if (typeof value === "number") {
        return Number.isFinite(value) ? value : 0;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

const API_BASE_URL = "http://localhost:4000";
export async function createInvoice(payload) {
    const response = await fetch(`${API_BASE_URL}/invoices`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    });
    if (!response.ok) {
        throw new Error("Could not create invoice.");
    }
    return response.json();
}
export async function getInvoice(id) {
    const response = await fetch(`${API_BASE_URL}/invoices/${id}`);
    if (!response.ok) {
        throw new Error("Could not load invoice.");
    }
    return response.json();
}
export async function listInvoices() {
    const response = await fetch(`${API_BASE_URL}/invoices`);
    if (!response.ok) {
        throw new Error("Could not load invoices.");
    }
    return response.json();
}
export async function retryInvoice(id) {
    const response = await fetch(`${API_BASE_URL}/invoices/${id}/retry`, {
        method: "POST"
    });
    if (!response.ok) {
        throw new Error("Could not retry invoice.");
    }
    return response.json();
}
export async function getInvoiceSource(id) {
    const response = await fetch(`${API_BASE_URL}/invoices/${id}/source`);
    if (!response.ok) {
        throw new Error("Could not load invoice preview source.");
    }
    return response.json();
}
export async function saveExtractedInvoice(id, extracted) {
    const response = await fetch(`${API_BASE_URL}/invoices/${id}/extracted`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(extracted)
    });
    if (!response.ok) {
        throw new Error("Could not save extracted invoice.");
    }
    return response.json();
}
export async function approveInvoice(id) {
    const response = await fetch(`${API_BASE_URL}/invoices/${id}/approve`, {
        method: "POST"
    });
    if (!response.ok) {
        throw new Error("Could not approve invoice.");
    }
    return response.json();
}
export function getInvoiceCsvDownloadUrl(id) {
    return `${API_BASE_URL}/invoices/${id}/csv`;
}

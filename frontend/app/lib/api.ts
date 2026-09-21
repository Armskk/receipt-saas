// Thin client for the NestJS backend. All calls that need auth go through
// `apiFetch`, which attaches the stored JWT and, on a 401, clears it so the
// UI can bounce back to /login.

export const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

const TOKEN_KEY = 'receipt-saas.token';

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string) {
  try {
    window.localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* private mode / storage disabled — token just won't persist */
  }
}

export function clearToken() {
  try {
    window.localStorage.removeItem(TOKEN_KEY);
    window.localStorage.removeItem(WORKSPACE_KEY);
  } catch {
    /* ignore */
  }
}

// Which workspace the user last looked at — shared between the dashboard and
// the summary page so switching in one carries to the other.
const WORKSPACE_KEY = 'receipt-saas.workspace';

export function getStoredWorkspaceId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(WORKSPACE_KEY);
  } catch {
    return null;
  }
}

export function setStoredWorkspaceId(id: string) {
  try {
    window.localStorage.setItem(WORKSPACE_KEY, id);
  } catch {
    /* ignore */
  }
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function parseError(res: Response): Promise<string> {
  try {
    const body = await res.json();
    // Nest error shape: { message: string | string[], error, statusCode }
    if (Array.isArray(body?.message)) return body.message.join(', ');
    if (typeof body?.message === 'string') return body.message;
  } catch {
    /* not JSON */
  }
  return `Request failed (${res.status})`;
}

interface FetchOptions {
  method?: string;
  body?: unknown;
  form?: FormData;
  auth?: boolean;
}

export async function apiFetch<T>(
  path: string,
  opts: FetchOptions = {},
): Promise<T> {
  const { method = 'GET', body, form, auth = true } = opts;
  const headers: Record<string, string> = {};

  if (auth) {
    const token = getToken();
    if (!token) throw new ApiError(401, 'Not signed in');
    headers.Authorization = `Bearer ${token}`;
  }

  let payload: BodyInit | undefined;
  if (form) {
    payload = form; // browser sets multipart boundary
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  const res = await fetch(`${API_URL}${path}`, { method, headers, body: payload });

  if (res.status === 401) {
    clearToken();
    throw new ApiError(401, 'Session expired — please sign in again');
  }
  if (!res.ok) {
    throw new ApiError(res.status, await parseError(res));
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// --- Types (mirror the Prisma models the API returns) ---

export interface Workspace {
  id: string;
  name: string;
  lineUserId: string | null;
  telegramChatId: string | null;
  createdAt: string;
}

export interface ReceiptItem {
  id: string;
  description: string;
  quantity: string | null;
  unitPrice: string | null;
  amount: string;
  category: { id: string; name: string } | null;
}

export type ReceiptStatus =
  | 'PENDING'
  | 'PROCESSING'
  | 'PARSED'
  | 'CONFIRMED'
  | 'FAILED';

export interface Receipt {
  id: string;
  source: 'WEB' | 'LINE' | 'TELEGRAM';
  status: ReceiptStatus;
  imageKeys: string[];
  merchantName: string | null;
  purchaseDate: string | null;
  currency: string;
  subtotal: string | null;
  discountTotal: string | null;
  total: string | null;
  failureReason: string | null;
  createdAt: string;
  items: ReceiptItem[];
}

// --- Endpoints ---

export function login(email: string, password: string) {
  return apiFetch<{ accessToken: string }>('/auth/login', {
    method: 'POST',
    auth: false,
    body: { email, password },
  });
}

export function signup(input: {
  email: string;
  password: string;
  name: string;
  workspaceName: string;
}) {
  return apiFetch<{ accessToken: string }>('/auth/signup', {
    method: 'POST',
    auth: false,
    body: input,
  });
}

export function listWorkspaces() {
  return apiFetch<Workspace[]>('/workspaces');
}

export function listReceipts(workspaceId: string) {
  return apiFetch<Receipt[]>(`/workspaces/${workspaceId}/receipts`);
}

export interface UploadResult {
  receiptId: string;
  status: ReceiptStatus;
  imageCount: number;
  rejected: Array<{ filename: string; reason: string }>;
}

// One call = one receipt. Pass several files only when they are photos of the
// SAME receipt (sections of a long receipt, front/back, multi-page bill).
export function uploadReceipt(workspaceId: string, files: File[]) {
  const form = new FormData();
  for (const file of files) form.append('files', file);
  return apiFetch<UploadResult>(
    `/workspaces/${workspaceId}/receipts/upload`,
    { method: 'POST', form },
  );
}

export function confirmReceipt(workspaceId: string, receiptId: string) {
  return apiFetch<Receipt>(
    `/workspaces/${workspaceId}/receipts/${receiptId}/confirm`,
    { method: 'PATCH' },
  );
}

// --- Chat channels (LINE / Telegram) ---

export type ChannelName = 'line' | 'telegram';

// Which chats are linked to the workspace (the ids themselves are never sent).
export interface ChannelStatus {
  line: boolean;
  telegram: boolean;
}

export interface LinkCode {
  code: string; // e.g. ABCD-2345
  expiresAt: string;
}

export function getChannelStatus(workspaceId: string) {
  return apiFetch<ChannelStatus>(`/workspaces/${workspaceId}/channels`);
}

// Owners/admins only. The user sends this code to the bot to link their chat.
export function createLinkCode(workspaceId: string, channel: ChannelName) {
  return apiFetch<LinkCode>(
    `/workspaces/${workspaceId}/channels/${channel}/link-code`,
    { method: 'POST' },
  );
}

export function unlinkChannel(workspaceId: string, channel: ChannelName) {
  return apiFetch<ChannelStatus>(
    `/workspaces/${workspaceId}/channels/${channel}`,
    { method: 'DELETE' },
  );
}

export interface MonthlySummary {
  month: string; // YYYY-MM
  currency: string;
  receiptCount: number;
  total: string;
  byCategory: Array<{ category: string; amount: string; itemCount: number }>;
  byDay: Array<{ date: string; amount: string; receiptCount: number }>;
  topMerchants: Array<{ merchant: string; amount: string; receiptCount: number }>;
}

export function listMonths(workspaceId: string) {
  return apiFetch<string[]>(`/workspaces/${workspaceId}/receipts/summary/months`);
}

export function getSummary(workspaceId: string, month: string) {
  return apiFetch<MonthlySummary>(
    `/workspaces/${workspaceId}/receipts/summary?month=${month}`,
  );
}

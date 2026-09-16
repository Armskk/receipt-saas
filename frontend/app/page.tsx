'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ApiError,
  confirmReceipt,
  listReceipts,
  uploadReceipt,
  type Receipt,
} from './lib/api';
import { useWorkspace } from './lib/useWorkspace';

const STATUS_LABEL: Record<Receipt['status'], string> = {
  PENDING: 'Queued',
  PROCESSING: 'Reading…',
  PARSED: 'Ready to review',
  CONFIRMED: 'Confirmed',
  FAILED: 'Failed',
};

function money(value: string | null, currency: string) {
  if (value == null) return '—';
  return `${Number(value).toLocaleString()} ${currency}`;
}

export default function DashboardPage() {
  const {
    ready,
    workspaces,
    workspaceId,
    setWorkspaceId,
    signOut,
    error: wsError,
  } = useWorkspace();
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    if (!workspaceId) return;
    try {
      setReceipts(await listReceipts(workspaceId));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) signOut();
      else if (err instanceof Error) setError(err.message);
    }
  }, [workspaceId, signOut]);

  // Poll while a workspace is selected — status flips async in the worker.
  useEffect(() => {
    if (!workspaceId) return;
    setReceipts([]);
    setSelectedId(null);
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [workspaceId, refresh]);

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files ? Array.from(e.target.files) : [];
    e.target.value = '';
    if (files.length === 0 || !workspaceId) return;
    setUploading(true);
    setError(null);
    setNotice(null);
    try {
      const { imageCount, rejected } = await uploadReceipt(workspaceId, files);
      const parts = [
        `Queued 1 receipt (${imageCount} photo${imageCount === 1 ? '' : 's'})`,
      ];
      if (rejected.length > 0) {
        parts.push(
          `skipped ${rejected.length}: ${rejected.map((r) => r.filename).join(', ')}`,
        );
      }
      setNotice(parts.join(' · '));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  async function handleConfirm(receiptId: string) {
    try {
      await confirmReceipt(workspaceId, receiptId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Confirm failed');
    }
  }

  if (!ready) {
    return (
      <main className="wrap">
        <p className="muted">Loading…</p>
      </main>
    );
  }

  const selected = receipts.find((r) => r.id === selectedId) ?? null;

  return (
    <main className="wrap">
      <header className="topbar">
        <div>
          <nav className="tabs">
            <span className="tab active">Receipts</span>
            <Link className="tab" href="/summary">
              Monthly summary
            </Link>
          </nav>
          {workspaces.length > 1 ? (
            <select
              value={workspaceId}
              onChange={(e) => setWorkspaceId(e.target.value)}
            >
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          ) : (
            <span className="muted">{workspaces[0]?.name}</span>
          )}
        </div>
        <button type="button" className="ghost" onClick={signOut}>
          Sign out
        </button>
      </header>

      {wsError && <p className="error">{wsError}</p>}

      <div className="card uploader">
        <label>
          <strong>Upload a receipt</strong>
          <span className="muted">
            {' '}
            — one photo, or several photos of the same receipt
          </span>
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            multiple
            onChange={handleUpload}
            disabled={uploading}
          />
        </label>
        {uploading && <p className="muted">Uploading + queuing for the agent…</p>}
        {notice && <p className="muted">{notice}</p>}
        {error && <p className="error">{error}</p>}
      </div>

      <div className="columns">
        <ul className="receipt-list">
          {receipts.length === 0 && (
            <li className="muted">No receipts yet.</li>
          )}
          {receipts.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                className={`receipt-row${r.id === selectedId ? ' active' : ''}`}
                onClick={() => setSelectedId(r.id)}
              >
                <span className="merchant">
                  {r.merchantName ?? '(processing…)'}
                </span>
                <span className={`badge s-${r.status}`}>
                  {STATUS_LABEL[r.status]}
                </span>
                <span className="amount">{money(r.total, r.currency)}</span>
              </button>
            </li>
          ))}
        </ul>

        {selected && (
          <div className="card detail">
            <h2>{selected.merchantName ?? 'Receipt'}</h2>
            <p className="muted">
              {selected.purchaseDate
                ? new Date(selected.purchaseDate).toLocaleDateString()
                : 'No date'}{' '}
              · via {selected.source} · {STATUS_LABEL[selected.status]}
              {selected.imageKeys.length > 1 &&
                ` · ${selected.imageKeys.length} photos`}
            </p>

            {selected.status === 'FAILED' && (
              <p className="error">{selected.failureReason}</p>
            )}

            {selected.items.length > 0 && (
              <table>
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Category</th>
                    <th className="num">Qty</th>
                    <th className="num">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {selected.items.map((it) => (
                    <tr key={it.id}>
                      <td>{it.description}</td>
                      <td className="muted">{it.category?.name ?? '—'}</td>
                      <td className="num">{it.quantity ?? '—'}</td>
                      <td className="num">
                        {money(it.amount, selected.currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <dl className="totals">
              {selected.discountTotal && (
                <div>
                  <dt>Discount</dt>
                  <dd>-{money(selected.discountTotal, selected.currency)}</dd>
                </div>
              )}
              <div>
                <dt>Total</dt>
                <dd>{money(selected.total, selected.currency)}</dd>
              </div>
            </dl>

            {selected.status === 'PARSED' && (
              <button type="button" onClick={() => handleConfirm(selected.id)}>
                Confirm
              </button>
            )}
          </div>
        )}
      </div>
    </main>
  );
}

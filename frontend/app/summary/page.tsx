'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ApiError, getSummary, type MonthlySummary } from '../lib/api';
import { useWorkspace } from '../lib/useWorkspace';

function thisMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function money(value: string, currency: string): string {
  return `${Number(value).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ${currency}`;
}

export default function SummaryPage() {
  const { ready, workspaces, workspaceId, setWorkspaceId, signOut, error: wsError } =
    useWorkspace();
  const [month, setMonth] = useState(thisMonth());
  const [data, setData] = useState<MonthlySummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    setError(null);
    try {
      setData(await getSummary(workspaceId, month));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) signOut();
      else setError(err instanceof Error ? err.message : 'Failed to load summary');
    } finally {
      setLoading(false);
    }
  }, [workspaceId, month, signOut]);

  useEffect(() => {
    load();
  }, [load]);

  if (!ready) {
    return (
      <main className="wrap">
        <p className="muted">Loading…</p>
      </main>
    );
  }

  const maxCategory = data
    ? Math.max(1, ...data.byCategory.map((c) => Number(c.amount)))
    : 1;
  const maxDay = data ? Math.max(1, ...data.byDay.map((d) => Number(d.amount))) : 1;

  return (
    <main className="wrap">
      <header className="topbar">
        <div>
          <nav className="tabs">
            <Link className="tab" href="/">
              Receipts
            </Link>
            <span className="tab active">Monthly summary</span>
            <Link className="tab" href="/connect">
              Connect chat
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

      <div className="month-nav">
        <button
          type="button"
          className="ghost"
          onClick={() => setMonth((m) => shiftMonth(m, -1))}
        >
          ‹
        </button>
        <strong>{monthLabel(month)}</strong>
        <button
          type="button"
          className="ghost"
          onClick={() => setMonth((m) => shiftMonth(m, 1))}
          disabled={month >= thisMonth()}
        >
          ›
        </button>
      </div>

      {error && <p className="error">{error}</p>}
      {loading && !data && <p className="muted">Loading…</p>}

      {data && (
        <>
          <div className="card total-card">
            <span className="muted">Total spend</span>
            <span className="big-number">{money(data.total, data.currency)}</span>
            <span className="muted">
              {data.receiptCount} receipt{data.receiptCount === 1 ? '' : 's'}
            </span>
          </div>

          {data.receiptCount === 0 ? (
            <p className="muted">No receipts recorded this month.</p>
          ) : (
            <>
              <section className="card">
                <h2>By category</h2>
                <ul className="bars">
                  {data.byCategory.map((c) => (
                    <li key={c.category}>
                      <div className="bar-row">
                        <span>{c.category}</span>
                        <span className="muted">
                          {money(c.amount, data.currency)}
                        </span>
                      </div>
                      <div className="bar-track">
                        <div
                          className="bar-fill"
                          style={{
                            width: `${(Number(c.amount) / maxCategory) * 100}%`,
                          }}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              </section>

              <section className="card">
                <h2>By day</h2>
                <div className="daychart">
                  {data.byDay.map((d) => (
                    <div key={d.date} className="daycol" title={`${d.date} · ${money(d.amount, data.currency)}`}>
                      <div
                        className="daybar"
                        style={{
                          height: `${Math.max(4, (Number(d.amount) / maxDay) * 100)}%`,
                        }}
                      />
                      <span className="daylabel">{d.date.slice(8)}</span>
                    </div>
                  ))}
                </div>
              </section>

              <section className="card">
                <h2>Top merchants</h2>
                <table>
                  <tbody>
                    {data.topMerchants.map((m) => (
                      <tr key={m.merchant}>
                        <td>{m.merchant}</td>
                        <td className="muted">
                          {m.receiptCount} receipt{m.receiptCount === 1 ? '' : 's'}
                        </td>
                        <td className="num">{money(m.amount, data.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            </>
          )}
        </>
      )}
    </main>
  );
}

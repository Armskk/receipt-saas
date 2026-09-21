'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ApiError,
  createLinkCode,
  getChannelStatus,
  unlinkChannel,
  type ChannelName,
  type ChannelStatus,
  type LinkCode,
} from '../lib/api';
import { useWorkspace } from '../lib/useWorkspace';

// Optional deep links, set at build time (see frontend/.env.example). Without
// them the page just tells the user to find the bot themselves.
const LINE_ADD_URL = process.env.NEXT_PUBLIC_LINE_ADD_FRIEND_URL;
const TELEGRAM_BOT = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME;

function formatRemaining(ms: number) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function ChannelCard({
  workspaceId,
  channel,
  title,
  linked,
  onStatus,
  onUnauthorized,
}: {
  workspaceId: string;
  channel: ChannelName;
  title: string;
  linked: boolean;
  onStatus: (s: ChannelStatus) => void;
  onUnauthorized: () => void;
}) {
  const [code, setCode] = useState<LinkCode | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A different workspace means a different code — drop the old one.
  useEffect(() => {
    setCode(null);
    setError(null);
  }, [workspaceId]);

  // Count down while a code is showing; hide it once it has expired.
  useEffect(() => {
    if (!code) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [code]);

  // The bot linked the chat: the code has done its job.
  useEffect(() => {
    if (linked) setCode(null);
  }, [linked]);

  const remaining = code ? new Date(code.expiresAt).getTime() - now : 0;
  const expired = code !== null && remaining <= 0;

  function fail(err: unknown) {
    if (err instanceof ApiError && err.status === 401) onUnauthorized();
    else setError(err instanceof Error ? err.message : 'Something went wrong');
  }

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      setCode(await createLinkCode(workspaceId, channel));
      setNow(Date.now());
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    if (!window.confirm(`Disconnect ${title}? Messages from it will no longer be added.`)) return;
    setBusy(true);
    setError(null);
    try {
      onStatus(await unlinkChannel(workspaceId, channel));
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  const raw = code?.code.replace('-', '') ?? '';
  const showCode = code !== null && !expired;

  return (
    <div className="card channel-card">
      <div className="channel-head">
        <h2>{title}</h2>
        <span className={`badge ${linked ? 's-CONFIRMED' : ''}`}>
          {linked ? 'Connected' : 'Not connected'}
        </span>
      </div>

      {linked && !showCode && (
        <p className="muted">
          Send a receipt photo to the {title} bot and it shows up in Receipts.
        </p>
      )}

      {showCode && (
        <div className="stack">
          <div className="code-box" aria-live="polite">
            {code.code}
          </div>
          <p className="muted">Expires in {formatRemaining(remaining)} · works once</p>
          {channel === 'line' ? (
            <ol className="steps">
              <li>
                Add the receipt bot on LINE
                {LINE_ADD_URL && (
                  <>
                    {' '}
                    (<a href={LINE_ADD_URL} target="_blank" rel="noreferrer">open</a>)
                  </>
                )}
                .
              </li>
              <li>Send it this code as a message.</li>
            </ol>
          ) : (
            <ol className="steps">
              <li>
                Open the receipt bot on Telegram
                {TELEGRAM_BOT && (
                  <>
                    {' '}
                    (
                    <a
                      href={`https://t.me/${TELEGRAM_BOT}?start=${raw}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      open with the code filled in
                    </a>
                    )
                  </>
                )}
                .
              </li>
              <li>
                Send <code>/start {raw}</code>, or just the code.
              </li>
            </ol>
          )}
          <p className="muted">This page updates by itself once the bot confirms.</p>
        </div>
      )}

      {expired && <p className="muted">That code expired — generate a new one.</p>}
      {error && <p className="error">{error}</p>}

      <div className="channel-actions">
        <button type="button" onClick={generate} disabled={busy}>
          {showCode
            ? 'New code'
            : linked
              ? 'Connect a different chat'
              : 'Generate connect code'}
        </button>
        {linked && (
          <button type="button" className="ghost" onClick={disconnect} disabled={busy}>
            Disconnect
          </button>
        )}
      </div>
    </div>
  );
}

export default function ConnectPage() {
  const {
    ready,
    workspaces,
    workspaceId,
    setWorkspaceId,
    signOut,
    error: wsError,
  } = useWorkspace();
  const [status, setStatus] = useState<ChannelStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!workspaceId) return;
    try {
      setStatus(await getChannelStatus(workspaceId));
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) signOut();
      else if (err instanceof Error) setError(err.message);
    }
  }, [workspaceId, signOut]);

  // Poll so the card flips to "Connected" as soon as the bot links the chat.
  useEffect(() => {
    if (!workspaceId) return;
    setStatus(null);
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [workspaceId, refresh]);

  if (!ready) {
    return (
      <main className="wrap">
        <p className="muted">Loading…</p>
      </main>
    );
  }

  return (
    <main className="wrap">
      <header className="topbar">
        <div>
          <nav className="tabs">
            <Link className="tab" href="/">
              Receipts
            </Link>
            <Link className="tab" href="/summary">
              Monthly summary
            </Link>
            <span className="tab active">Connect chat</span>
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
      {error && <p className="error">{error}</p>}

      <p className="muted">
        Connect a chat so you can add receipts by sending a photo to the bot. Generate a
        one-time code here, then send it to the bot from the chat you want to connect.
      </p>

      {workspaceId && status && (
        <div className="channel-grid">
          <ChannelCard
            workspaceId={workspaceId}
            channel="line"
            title="LINE"
            linked={status.line}
            onStatus={setStatus}
            onUnauthorized={signOut}
          />
          <ChannelCard
            workspaceId={workspaceId}
            channel="telegram"
            title="Telegram"
            linked={status.telegram}
            onStatus={setStatus}
            onUnauthorized={signOut}
          />
        </div>
      )}
    </main>
  );
}

'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { login, signup, setToken, ApiError } from '../lib/api';

type Mode = 'login' | 'signup';

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [workspaceName, setWorkspaceName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { accessToken } =
        mode === 'login'
          ? await login(email, password)
          : await signup({ email, password, name, workspaceName });
      setToken(accessToken);
      router.replace('/');
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Something went wrong',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-wrap">
      <div className="card auth-card">
        <h1>Receipt SaaS</h1>
        <p className="muted">
          {mode === 'login'
            ? 'Sign in to your workspace'
            : 'Create an account and your first workspace'}
        </p>

        <form onSubmit={handleSubmit} className="stack">
          <label className="field">
            <span>Email</span>
            <input
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>

          <label className="field">
            <span>Password</span>
            <input
              type="password"
              autoComplete={
                mode === 'login' ? 'current-password' : 'new-password'
              }
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>

          {mode === 'signup' && (
            <>
              <label className="field">
                <span>Your name</span>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label className="field">
                <span>Workspace name</span>
                <input
                  type="text"
                  required
                  placeholder="e.g. My Shop"
                  value={workspaceName}
                  onChange={(e) => setWorkspaceName(e.target.value)}
                />
              </label>
            </>
          )}

          {error && <p className="error">{error}</p>}

          <button type="submit" disabled={busy}>
            {busy
              ? 'Please wait…'
              : mode === 'login'
                ? 'Sign in'
                : 'Create account'}
          </button>
        </form>

        <p className="muted switch">
          {mode === 'login' ? (
            <>
              No account?{' '}
              <button
                type="button"
                className="link"
                onClick={() => {
                  setMode('signup');
                  setError(null);
                }}
              >
                Sign up
              </button>
            </>
          ) : (
            <>
              Already have one?{' '}
              <button
                type="button"
                className="link"
                onClick={() => {
                  setMode('login');
                  setError(null);
                }}
              >
                Sign in
              </button>
            </>
          )}
        </p>
      </div>
    </main>
  );
}

import { createHash, randomInt } from 'crypto';

// 32 symbols without 0/O/1/I, so a code survives being read off a screen and
// retyped into a chat. 8 symbols = 40 bits; with a 10-minute single-use window
// that's out of reach for guessing through the bot.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 8;
export const CODE_TTL_MS = 10 * 60 * 1000;

export function generateCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  return code;
}

/** `ABCD2345` -> `ABCD-2345` (what the dashboard shows). */
export function formatCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * Canonical form of user-typed input: separators removed, upper-cased. Returns
 * null unless it is exactly CODE_LENGTH symbols from the alphabet, so ordinary
 * chat text (which often contains 0/O/1/I or is the wrong length) is never
 * mistaken for a code.
 */
export function normalizeCode(input: string): string | null {
  const code = input.replace(/[\s-]/g, '').toUpperCase();
  if (code.length !== CODE_LENGTH) return null;
  for (const ch of code) if (!ALPHABET.includes(ch)) return null;
  return code;
}

export function hashCode(normalized: string): string {
  return createHash('sha256').update(normalized).digest('hex');
}

/**
 * Pulls a link code out of a chat message: either the bare code (`ABCD-2345`,
 * `abcd 2345`, `ABCD2345`) or Telegram's deep-link form (`/start ABCD2345`,
 * `/start@MyBot ABCD-2345`). Anything else returns null.
 */
export function extractLinkCode(text: string | undefined | null): string | null {
  if (!text) return null;
  const body = text.trim().replace(/^\/start(?:@\w+)?\s+/i, '');
  return normalizeCode(body);
}

import { resolveCorsOrigins } from './cors';

describe('resolveCorsOrigins', () => {
  it('uses exactly the configured origins', () => {
    expect(resolveCorsOrigins({ CORS_ORIGINS: 'https://app.example.com' })).toEqual(['https://app.example.com']);
  });

  it('accepts a comma-separated list, trims it and drops trailing slashes', () => {
    expect(
      resolveCorsOrigins({ CORS_ORIGINS: ' https://app.example.com/ , http://localhost:3000 ,, ' }),
    ).toEqual(['https://app.example.com', 'http://localhost:3000']);
  });

  it('defaults to the local dashboard outside production', () => {
    expect(resolveCorsOrigins({})).toEqual(['http://localhost:3000', 'http://127.0.0.1:3000']);
    expect(resolveCorsOrigins({ NODE_ENV: 'development' })).toContain('http://localhost:3000');
    expect(resolveCorsOrigins({ CORS_ORIGINS: '   ' })).toContain('http://localhost:3000');
  });

  it('refuses to start in production without CORS_ORIGINS (neither open nor silently locked out)', () => {
    expect(() => resolveCorsOrigins({ NODE_ENV: 'production' })).toThrow(/CORS_ORIGINS/);
    expect(() => resolveCorsOrigins({ NODE_ENV: 'production', CORS_ORIGINS: '' })).toThrow(/CORS_ORIGINS/);
  });

  it.each([['*'], ['app.example.com'], ['https://app.example.com/dashboard'], ['https://ok.example.com,*']])(
    'rejects %j (must be explicit bare origins)',
    (value) => {
      expect(() => resolveCorsOrigins({ CORS_ORIGINS: value })).toThrow(/Invalid CORS_ORIGINS/);
    },
  );

  it('rejects a bad entry even in development', () => {
    expect(() => resolveCorsOrigins({ NODE_ENV: 'development', CORS_ORIGINS: '*' })).toThrow();
  });
});

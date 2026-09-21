// Side-effect module: import it BEFORE anything that pulls in AppModule.
// AuthModule reads JWT_SECRET via requireEnv() while the module is being
// imported, so a spec that imports the module graph needs it set up front
// (CI has no .env). The value is a throwaway; nothing here signs real tokens.
process.env.JWT_SECRET ??= 'test-only-jwt-secret';

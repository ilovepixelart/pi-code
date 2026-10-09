/**
 * Authentication failures of an MCP connect, shared by the transport and the OAuth login
 * flow without either importing the other at runtime.
 */
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'

/** A server needs OAuth pi could not complete (headless, declined, or the flow
 * failed). A typed marker so the SSE-fallback caller can tell an auth failure
 * from a transport mismatch without matching on message text. */
export class OAuthRequiredError extends Error {}

/** Whether a connect failure is an authentication problem: the SDK's own
 * UnauthorizedError, a transport error carrying HTTP 401 or 403 (Claude: "either
 * status code flags it" for OAuth), or our own marker. */
export function isUnauthorized(error: unknown): boolean {
  if (error instanceof UnauthorizedError || error instanceof OAuthRequiredError) return true
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
  return code === 401 || code === 403
}

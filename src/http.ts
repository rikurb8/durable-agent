/**
 * Shared HTTP boundary for the local-only servers: read-only inspector and manager.
 * The manager reuses the inspector's exact Host, Origin, and Sec-Fetch-Site checks
 * and its Content-Security-Policy.
 */
import type { IncomingMessage, Server, ServerResponse } from "node:http";

const BASE_HEADERS: Record<string, string> = {
	"Cache-Control": "no-store",
	"X-Content-Type-Options": "nosniff",
	"Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

export function applySecurityHeaders(response: ServerResponse): void {
	for (const [name, value] of Object.entries(BASE_HEADERS)) response.setHeader(name, value);
}

/** Exact authority this loopback server is reachable at. */
export function localAuthority(server: Server): string {
	return `127.0.0.1:${(server.address() as { port: number }).port}`;
}

/**
 * True only for a request addressed to this exact loopback authority from a
 * same-origin, non-cross-site context. A browser without an Origin header
 * (same-origin GET navigation) passes; curl passes; cross-site fails.
 */
export function isLocalSameOrigin(request: IncomingMessage, server: Server): boolean {
	const authority = localAuthority(server);
	return request.headers.host === authority
		&& (request.headers.origin === undefined || request.headers.origin === `http://${authority}`)
		&& request.headers["sec-fetch-site"] !== "cross-site";
}

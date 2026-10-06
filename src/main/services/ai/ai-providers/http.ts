import { net } from 'electron'

const DEFAULT_TIMEOUT_MS = 60_000

/**
 * Wrapper around Electron's `net.fetch` that adds an abort-based timeout.
 *
 * `net.fetch` routes through Chromium's network stack rather than Node's
 * undici, and that distinction is the entire point of this wrapper:
 *
 *   1. Proxy support. Chromium reads the OS proxy configuration — macOS
 *      system settings, Windows WinINET, PAC scripts, GNOME proxy. Node's
 *      global `fetch` ignores all of it, so behind a corporate proxy or a
 *      VPN that installs a proxy shim, every request fails with
 *      `TypeError: fetch failed` wrapped in an `AggregateError`. That is
 *      exactly the symptom this helper exists to fix.
 *
 *   2. Happy Eyeballs. When DNS returns both IPv4 and IPv6 addresses and
 *      only one family is routable on the current network, Chromium falls
 *      back to the working family automatically. Undici tries every
 *      address in sequence and reports the whole batch as timed out —
 *      which is why the raw error carried sixteen nested failures.
 *
 *   3. OS certificate store. Corporate MITM proxies that inject a root CA
 *      work without extra Node-side configuration.
 *
 *   4. HTTP/2 and connection reuse behave like the browser's.
 *
 * The default timeout is 60 s — long enough for a large skeleton map to
 * reach Google's servers and get a response, short enough that a stuck
 * request does not hang the UI indefinitely.
 */
export async function httpFetch(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await net.fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Translate a network-layer error into a message the user can act on. The
 * raw failure is `TypeError: fetch failed` with a nested `AggregateError`
 * whose own message is empty; printing that verbatim, which is what the
 * generic error banner was doing, tells the user nothing about what to fix.
 */
export function describeFetchError(
  providerLabel: string,
  error: unknown,
): string {
  if (error instanceof Error && error.name === 'AbortError') {
    return `${providerLabel} did not respond within 60 seconds. Check your internet connection and try again.`
  }
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause
    if (cause instanceof Error && cause.name === 'AggregateError') {
      return `${providerLabel} could not be reached. This is almost always a proxy, VPN, or firewall blocking the connection, or no internet access at all. The request is made through Chromium's network stack, which honours your system proxy settings.`
    }
    if (cause && typeof cause === 'object' && 'code' in cause) {
      const code = String((cause as { code?: unknown }).code)
      switch (code) {
        case 'ENOTFOUND':
        case 'EAI_AGAIN':
          return `${providerLabel} hostname could not be resolved. Check your internet connection.`
        case 'ECONNREFUSED':
          return `${providerLabel} refused the connection. A firewall or proxy may be blocking outbound requests.`
        case 'CERT_HAS_EXPIRED':
        case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
        case 'SELF_SIGNED_CERT_IN_CHAIN':
          return `${providerLabel} presented a TLS certificate that could not be verified. A corporate proxy or antivirus may be intercepting HTTPS traffic.`
        case 'ETIMEDOUT':
          return `${providerLabel} timed out. A proxy, VPN, or firewall is likely blocking the connection.`
      }
      return `${providerLabel} request failed (${code}): ${error.message}`
    }
    return `${providerLabel} request failed: ${error.message}`
  }
  return `${providerLabel} request failed: ${String(error)}`
}
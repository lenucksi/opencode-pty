/**
 * Headers for every response a browser may fetch and then decide what it is.
 *
 * Kept in one module so the static server and the new `/api/licenses` handler
 * cannot drift apart. A JSON response is not a document, so most of these are
 * inert there - but `nosniff` is not: it is what stops a browser from treating a
 * downloaded licence list as HTML or a script based on its first bytes.
 */
export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-XSS-Protection': '1; mode=block',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  // `script-src` keeps `'wasm-unsafe-eval'` (Chromium and Firefox require it to
  // compile the ghostty-web WebAssembly module; it does NOT enable JS `eval`).
  // The WASM is served as a same-origin asset under `default-src 'self'`, so no
  // `connect-src data:` is needed. All scripts and styles are emitted as
  // external same-origin assets, so `'unsafe-inline'` is not needed anywhere.
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self';",
} as const

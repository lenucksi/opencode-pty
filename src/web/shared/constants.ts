// Web-specific constants for the web server and related components

export const RETRY_DELAY = 500
export const SKIP_AUTOSELECT_KEY = 'skip-autoselect'

// Asset and file serving constants
export const ASSET_CONTENT_TYPES: Record<string, string> = {
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.html': 'text/html',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
}

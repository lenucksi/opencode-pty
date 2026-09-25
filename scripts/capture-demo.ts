/**
 * Records the README demo and converts the capture to a GIF.
 *
 * The demo runs against a throwaway server with an isolated state directory and
 * canned session output, so no real sessions or data end up in the recording.
 *
 * Usage: bun run capture:demo
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
const PORT_FILE = '/tmp/demo-server-port.txt'
const STATE_DIR = '/tmp/opencode-pty-demo/state'
const RAW_DIR = join(ROOT, 'test-results', 'demo-raw')
const MEDIA_DIR = join(ROOT, 'docs', 'media')
const GIF_PATH = join(MEDIA_DIR, 'web-ui-demo.gif')
const POSTER_PATH = join(MEDIA_DIR, 'web-ui-demo-poster.png')

const TARGET_WIDTH = 960
const FPS = 15
const MAX_GIF_BYTES = 3 * 1024 * 1024

interface ServerHandle {
  origin: string
  stop: () => Promise<void>
}

async function waitForFile(path: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const content = (await readFile(path, 'utf8')).trim()
      if (content.length > 0) return content
    }
    await Bun.sleep(200)
  }
  throw new Error(`Timed out waiting for ${path}`)
}

function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string | undefined> } = {}
): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? ROOT,
      env: { ...process.env, ...options.env },
      stdio: 'inherit',
    })
    child.on('error', rejectPromise)
    child.on('exit', (code) => resolvePromise(code ?? 1))
  })
}

async function startDemoServer(): Promise<ServerHandle> {
  await rm(PORT_FILE, { force: true })
  await rm(STATE_DIR, { recursive: true, force: true })
  await mkdir(STATE_DIR, { recursive: true })

  const child = spawn('bun', ['run', 'test/e2e/demo-web-server.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      OPENCODE_PTY_STATE_DIR: STATE_DIR,
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  })

  const href = await waitForFile(PORT_FILE, 30_000)
  // The server binds the IPv6 loopback. Chromium resolves `localhost` to `::1`
  // first but can still fall back, so pin the family explicitly for a
  // reproducible recording.
  const url = new URL(href)
  const origin = `http://[::1]:${url.port}`

  return {
    origin,
    stop: async () => {
      child.kill()
      await Bun.sleep(500)
    },
  }
}

async function runCapture(baseURL: string): Promise<void> {
  await rm(RAW_DIR, { recursive: true, force: true })

  const code = await run(
    'bun',
    ['x', 'playwright', 'test', '--config', 'playwright.demo.config.ts'],
    {
      env: { DEMO_BASE_URL: baseURL },
    }
  )
  if (code !== 0) {
    throw new Error(`Playwright capture failed with exit code ${code}`)
  }
}

async function findVideo(): Promise<string> {
  const candidates: string[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(path)
      } else if (entry.name.endsWith('.webm')) {
        candidates.push(path)
      }
    }
  }

  for (const dir of [join(ROOT, 'test-results', 'demo'), RAW_DIR]) {
    if (existsSync(dir)) {
      await walk(dir)
    }
  }

  if (candidates.length === 0) {
    throw new Error('No .webm capture found')
  }

  // Playwright names the file after the test; pick the largest for stability.
  const sized = await Promise.all(
    candidates.map(async (path) => ({ path, size: (await stat(path)).size }))
  )
  sized.sort((a, b) => b.size - a.size)
  const largest = sized[0]
  if (!largest) {
    throw new Error('No .webm capture found')
  }
  return largest.path
}

async function buildFilter(fps: number, width: number): Promise<string> {
  return [
    // Pace the clip, cap the framerate and keep motion smooth.
    `fps=${fps}`,
    // Split the scale expression so very wide captures stay under control.
    `scale=${width}:-1:flags=lanczos`,
    // Ordered palette, then use it: much smaller and cleaner than a raw dump.
    `split[s0][s1]`,
    `[s0]palettegen=max_colors=192:stats_mode=diff[p]`,
    `[s1][p]paletteuse=dither=bayer:bayer_scale=4`,
  ].join(',')
}

async function convertToGif(videoPath: string): Promise<void> {
  await mkdir(MEDIA_DIR, { recursive: true })
  await rm(GIF_PATH, { force: true })

  const filter = await buildFilter(FPS, TARGET_WIDTH)
  const code = await run('ffmpeg', [
    '-y',
    '-i',
    videoPath,
    '-filter_complex',
    filter,
    '-loop',
    '0',
    GIF_PATH,
  ])

  if (code !== 0) {
    throw new Error(`ffmpeg GIF conversion failed with exit code ${code}`)
  }

  const { size } = await stat(GIF_PATH)
  if (size > MAX_GIF_BYTES) {
    console.warn(
      `GIF is ${(size / 1024 / 1024).toFixed(2)} MB, above the ${MAX_GIF_BYTES / 1024 / 1024} MB target`
    )
  } else {
    console.log(`GIF is ${(size / 1024 / 1024).toFixed(2)} MB`)
  }
}

async function extractPoster(videoPath: string): Promise<void> {
  await rm(POSTER_PATH, { force: true })
  // 6s lands on the grouped sidebar with a session already selected, which is
  // the most representative single frame of the demo.
  const code = await run('ffmpeg', [
    '-y',
    '-i',
    videoPath,
    '-ss',
    '00:00:06',
    // `-update 1` is required for a single-frame output without a sequence
    // pattern; ffmpeg otherwise refuses to pick an image muxer.
    '-frames:v',
    '1',
    '-update',
    '1',
    '-vf',
    `scale=${TARGET_WIDTH}:-1:flags=lanczos`,
    POSTER_PATH,
  ])
  if (code !== 0) {
    console.warn('Poster extraction failed; the GIF alone will be used')
  }
}

async function main(): Promise<void> {
  if (!existsSync(join(ROOT, 'dist', 'web', 'index.html'))) {
    console.log('Building the web client with test hooks enabled...')
    const buildCode = await run('bun', ['run', 'build:prod'], {
      env: { VITE_EXPOSE_TEST_HOOKS: '1' },
    })
    if (buildCode !== 0) {
      throw new Error('Build failed')
    }
  }

  const server = await startDemoServer()
  try {
    console.log(`Recording demo against ${server.origin}`)
    await runCapture(server.origin)
  } finally {
    await server.stop()
  }

  const video = await findVideo()
  console.log(`Converting ${video}`)
  await convertToGif(video)
  await extractPoster(video)

  console.log(`Wrote ${GIF_PATH}`)
}

await main()

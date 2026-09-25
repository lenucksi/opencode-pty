import { runAislopCheck } from './quality/aislop.ts'

try {
  await runAislopCheck()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}

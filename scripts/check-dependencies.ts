import { runDependencyCheck } from './quality/dependencies.ts'

try {
  await runDependencyCheck()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}

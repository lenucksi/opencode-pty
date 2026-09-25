import { runLocalQualityGate } from './quality/local-gate.ts'

process.exit(await runLocalQualityGate())

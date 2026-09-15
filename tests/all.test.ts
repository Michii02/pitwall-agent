// Keep the companion test suite in one Node process. This is materially more
// reliable on constrained Windows installs than Node's default one-process-
// per-file test runner, while each imported file still registers independent
// node:test cases.
import os from 'node:os'
import path from 'node:path'
import { configureLogger } from '../src/utils/logger'
import './health.test'
import './parser-diagnostics.test'
import './packet-processing.test'
import './listener.test'
import './relay.test'
import './offline-sync.test'
import './live.test'
import './grid-status.test'
import './sources.test'

configureLogger({
  level: 'error',
  maxSizeMb: 1,
  maxFiles: 1,
  filePath: path.join(os.tmpdir(), `pitwall-agent-test-${process.pid}.log`),
})

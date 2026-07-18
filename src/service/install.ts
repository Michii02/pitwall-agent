/**
 * Registers the agent as a Windows service ("PitWall Agent") via node-windows.
 * Run once after install: `npm run service:install` (elevated prompt).
 */

import path from 'node:path'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Service } = require('node-windows')

const svc = new Service({
  name: 'PitWall Agent',
  description: 'PitWall UDP telemetry agent — captures F1 sessions in the background and syncs them to PitWall.',
  script: path.join(__dirname, '..', 'index.js'),
  nodeOptions: [],
  // Restart behaviour on crash
  wait: 2,
  grow: 0.5,
  maxRetries: 40,
})

svc.on('install', () => {
  console.log('PitWall Agent service installed — starting…')
  svc.start()
})
svc.on('alreadyinstalled', () => console.log('PitWall Agent service is already installed.'))
svc.on('start', () => console.log('PitWall Agent service started.'))
svc.on('error', (err: Error) => console.error('Service error:', err.message))

svc.install()

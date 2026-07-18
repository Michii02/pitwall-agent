/** Removes the "PitWall Agent" Windows service. Run: `npm run service:uninstall`. */

import path from 'node:path'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Service } = require('node-windows')

const svc = new Service({
  name: 'PitWall Agent',
  script: path.join(__dirname, '..', 'index.js'),
})

svc.on('uninstall', () => console.log('PitWall Agent service removed.'))
svc.on('error', (err: Error) => console.error('Service error:', err.message))

svc.uninstall()

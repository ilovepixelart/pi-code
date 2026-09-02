/**
 * E2e wire probe: records every provider request payload as one JSON line in
 * the file named by PI_E2E_WIRE. The captured payload is the deterministic
 * oracle the e2e checks grep: what the model was actually sent, independent of
 * model recall, and written before the transport acts, so it exists even when
 * the request then fails (the headless smoke points the model at a dead port).
 */
import * as fs from 'node:fs'

export default function wireProbe(pi: { on: (event: string, handler: (event: unknown) => void) => void }) {
  pi.on('before_provider_request', (event) => {
    const target = process.env.PI_E2E_WIRE
    if (target) fs.appendFileSync(target, `${JSON.stringify(event)}\n`)
  })
}

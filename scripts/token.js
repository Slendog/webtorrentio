// Print a new random access token for ACCESS_TOKENS.
import crypto from 'node:crypto'

console.log(crypto.randomBytes(24).toString('base64url'))

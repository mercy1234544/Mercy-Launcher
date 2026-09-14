'use strict';

/** Builds a token string in the same wire shape PresenceManager.createJoinToken()
 * produces (contract §5): base64url(JSON body) + '.' + base64url(signature).
 * The relay never verifies the signature itself (docs/backend-architecture.md §4),
 * so tests can use any placeholder signature bytes. */
function buildJoinToken(payload, fakeSig = 'test-sig') {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = Buffer.from(fakeSig).toString('base64url');
  return `${body}.${sig}`;
}

module.exports = { buildJoinToken };

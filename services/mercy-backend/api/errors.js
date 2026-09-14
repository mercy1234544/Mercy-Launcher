'use strict';

// Distinct, stable error codes so the client can finally tell
// NETWORK_ERROR / AUTH_ERROR / SERVER_ERROR / USER_NOT_FOUND apart instead
// of collapsing everything into "Unable to connect to Mercy services." —
// this is the exact vagueness the original audit flagged (weakness #4).
class ApiError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || 400;
  }
}

module.exports = { ApiError };

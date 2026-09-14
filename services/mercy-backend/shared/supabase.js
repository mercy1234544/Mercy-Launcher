'use strict';

const { createClient } = require('@supabase/supabase-js');
const { required } = require('./env');

let client = null;
let testOverride = null;

/** Service-role client — server-side only, bypasses RLS by design (used for
 * authorization checks the relay must perform itself, e.g. join_requests lookup). */
function getServiceClient() {
  if (testOverride) return testOverride;
  if (client) return client;
  const url = required('SUPABASE_URL');
  const key = required('SUPABASE_SERVICE_ROLE_KEY');
  client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}

/** Test-only: inject a fake client so tests never touch a real Supabase project. */
function _setServiceClientForTesting(fakeClient) {
  testOverride = fakeClient;
}

module.exports = { getServiceClient, _setServiceClientForTesting };

// The isolation environment values are judged before they are used, because
// the alternative was a masked key reaching an HTTP header and taking down
// login with "Cannot convert argument to a ByteString". Every case here is a
// paste that has to degrade to the service key with an explanation, not throw.
//
//   node --experimental-strip-types scripts/test-tenant-config.mjs

import { describeTenantConfig } from "../src/lib/db.ts";

let passed = 0;
let failed = 0;

function check(name, ok) {
  if (ok) passed++;
  else {
    failed++;
    console.log(`FAIL ${name}`);
  }
}

const realAnon =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJvbGUiOiJhbm9uIn0.8iVpt6IrPn0LFlz3z6LYS_Z0UHa3bcO1EG9YFKKOyG8";
const realSecret = "a-long-enough-app-secret-value-000000";

// The paste that broke login: the dashboard's masked display.
const masked = describeTenantConfig("eyJhbGci••••••••••••", realSecret);
check("masked key is refused", masked.ready === false);
check("masked key says why", /bullet/.test(masked.problem ?? ""));
check("masked key names the variable", /SUPABASE_ANON_KEY/.test(masked.problem ?? ""));

// Everything else that cannot go in a header.
check("curly quote refused", describeTenantConfig("eyJhbGci“abc", realSecret).ready === false);
check("newline refused", describeTenantConfig("eyJhbGci\nabc.def.ghi", realSecret).ready === false);
check("wrapped-with-space refused", describeTenantConfig("eyJhbGci abc.def.ghi", realSecret).ready === false);

// Wrong value in the right variable.
check("not a key at all", describeTenantConfig("your_anon_key_here", realSecret).ready === false);
// A publishable key is fine now: Supabase issues the token, so nothing here
// has to match a signing secret.
const pub = describeTenantConfig("sb_publishable_6LvzXVbY2ETXx_ReinNQmg_08uRPwIx", realSecret);
check("publishable key accepted", pub.ready === true);

// Missing values are a state, not an error.
check("both unset", describeTenantConfig("", "").ready === false);
check("both unset explains the consequence", /bypassed|service key/.test(describeTenantConfig("", "").problem ?? ""));
check("anon set, APP_SECRET missing", describeTenantConfig(realAnon, "").ready === false);
check("APP_SECRET missing names itself", /APP_SECRET/.test(describeTenantConfig(realAnon, "").problem ?? ""));
check("APP_SECRET too short", describeTenantConfig(realAnon, "short").ready === false);

// The shapes that must work.
check("real pair is ready", describeTenantConfig(realAnon, realSecret).ready === true);
check("real pair has no problem", describeTenantConfig(realAnon, realSecret).problem === null);
check("quoted values are forgiven", describeTenantConfig(`"${realAnon}"`, `'${realSecret}'`).ready === true);
check("surrounding whitespace is forgiven", describeTenantConfig(`  ${realAnon}\n`, ` ${realSecret} `).ready === true);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

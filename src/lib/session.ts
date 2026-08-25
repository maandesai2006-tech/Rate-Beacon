// The session cookie name, alone, with no imports.
//
// Edge middleware and the public pages need this constant and nothing else
// from the auth module. Keeping it here stops them from pulling in the
// database client — which signs account tokens with node:crypto and cannot be
// bundled for the Edge runtime.
export const SESSION_COOKIE = "rb_session";

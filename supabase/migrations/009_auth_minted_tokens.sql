-- Let Supabase mint the scoped token instead of signing one ourselves.
--
-- The first cut signed an HS256 token with the project's legacy JWT secret.
-- Projects created under the new API-key system verify with asymmetric signing
-- keys instead, whose private half is never exposed — so a self-signed token
-- is rejected with "No suitable key or wrong key type" no matter what secret
-- is configured. Nothing about that is fixable from the application side.
--
-- So each account gets a Supabase auth user, and the app asks Supabase for
-- that user's access token. The token is then signed with whatever key the
-- project actually uses, today and after any future rotation, and the app
-- holds no signing key at all. The account id travels in app_metadata, which
-- only the service role can write — a customer cannot mint themselves a token
-- for someone else's account.

alter table accounts add column if not exists auth_user_id uuid;
create unique index if not exists accounts_auth_user_idx on accounts (auth_user_id);

-- Read the account id from either shape: app_metadata is where a
-- Supabase-issued token carries it, and the top-level claim is kept so a
-- deployment still on a self-signed token keeps working through the change.
create or replace function app_account_id() returns bigint
language sql stable as $$
  select nullif(
    coalesce(
      current_setting('request.jwt.claims', true)::json ->> 'account_id',
      current_setting('request.jwt.claims', true)::json -> 'app_metadata' ->> 'account_id',
      ''
    ),
    ''
  )::bigint
$$;

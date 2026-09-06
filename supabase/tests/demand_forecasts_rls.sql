-- Run after migration 023 as postgres (or another role that can SET ROLE),
-- for example: psql -v ON_ERROR_STOP=1 -f supabase/tests/demand_forecasts_rls.sql
-- Uses the application's existing schema and app_metadata authorization.
-- No pgTAP extension is required. All fixtures and writes are rolled back.
begin;

do $$
declare
  account_a bigint;
  account_b bigint;
  profile_a bigint;
  profile_b bigint;
  fixture_prefix text := '__forecast_rls_' || txid_current()::text;
begin
  insert into public.accounts (email, password_hash, password_salt)
  values (fixture_prefix || '_a@example.invalid', repeat('0', 64), repeat('0', 32))
  returning id into account_a;
  insert into public.accounts (email, password_hash, password_salt)
  values (fixture_prefix || '_b@example.invalid', repeat('0', 64), repeat('0', 32))
  returning id into account_b;
  insert into public.profiles (name, account_id)
  values (fixture_prefix || '_a', account_a) returning id into profile_a;
  insert into public.profiles (name, account_id)
  values (fixture_prefix || '_b', account_b) returning id into profile_b;

  insert into public.hotels (hotel_id, name)
  values (fixture_prefix || '_a', 'Forecast RLS fixture A'),
         (fixture_prefix || '_b', 'Forecast RLS fixture B');
  insert into public.profile_hotels (profile_id, hotel_id, is_mine)
  values (profile_a, fixture_prefix || '_a', true),
         (profile_b, fixture_prefix || '_b', true);
  insert into public.demand_forecasts (
    profile_id, hotel_id, check_in, demand_score, forecast_median,
    suggested_low, suggested_high, confidence, signals, forecast, context_key
  ) values
    (profile_a, fixture_prefix || '_a', current_date, 50, 100,
     null, null, 0.2, '[]', '{"pricingEnabled":false}', 'fixture-context-a'),
    (profile_b, fixture_prefix || '_b', current_date, 50, 120,
     90, 125, 0.2, '[]', '{"pricingEnabled":false}', 'fixture-context-b');

  perform set_config('forecast_test.account_a', account_a::text, true);
  perform set_config('forecast_test.account_b', account_b::text, true);
  perform set_config('forecast_test.profile_a', profile_a::text, true);
  perform set_config('forecast_test.profile_b', profile_b::text, true);
  perform set_config('forecast_test.hotel_a', fixture_prefix || '_a', true);
  perform set_config('forecast_test.hotel_b', fixture_prefix || '_b', true);

  if not (select relrowsecurity from pg_class
          where oid = 'public.demand_forecasts'::regclass) then
    raise exception 'demand_forecasts must have RLS enabled';
  end if;
  if not has_table_privilege('authenticated', 'public.demand_forecasts', 'SELECT') then
    raise exception 'authenticated must have SELECT privilege';
  end if;
  if has_table_privilege('authenticated', 'public.demand_forecasts',
                         'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') then
    raise exception 'authenticated unexpectedly has a write/DDL privilege';
  end if;
  if has_table_privilege('anon', 'public.demand_forecasts',
                         'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') then
    raise exception 'anon unexpectedly has table access';
  end if;
end $$;

set local role authenticated;
select set_config('request.jwt.claims', jsonb_build_object(
  'role', 'authenticated',
  'app_metadata', jsonb_build_object('account_id', current_setting('forecast_test.account_a')::bigint)
)::text, true);

do $$
declare
  statement text;
begin
  if (select count(*) from public.demand_forecasts) <> 1 then
    raise exception 'Account A must see exactly its own forecast';
  end if;
  if not exists (select 1 from public.demand_forecasts
                 where hotel_id = current_setting('forecast_test.hotel_a')) then
    raise exception 'Account A cannot read its own forecast';
  end if;
  if exists (select 1 from public.demand_forecasts
             where profile_id = current_setting('forecast_test.profile_b')::bigint) then
    raise exception 'Account A can read account B forecast';
  end if;

  foreach statement in array array[
    $q$insert into public.demand_forecasts
       (profile_id, hotel_id, check_in, demand_score, confidence, signals, forecast, context_key)
       values (current_setting('forecast_test.profile_a')::bigint,
               current_setting('forecast_test.hotel_a'), current_date + 1,
               50, 0.2, '[]', '{}', 'forbidden')$q$,
    $q$update public.demand_forecasts set demand_score = 99
       where profile_id = current_setting('forecast_test.profile_a')::bigint$q$,
    $q$delete from public.demand_forecasts
       where profile_id = current_setting('forecast_test.profile_a')::bigint$q$
  ] loop
    begin
      execute statement;
      raise exception 'Authenticated write unexpectedly succeeded: %', statement;
    exception when insufficient_privilege then null;
    end;
  end loop;
end $$;

select set_config('request.jwt.claims', jsonb_build_object(
  'role', 'authenticated',
  'app_metadata', jsonb_build_object('account_id', current_setting('forecast_test.account_b')::bigint)
)::text, true);
do $$
begin
  if (select count(*) from public.demand_forecasts) <> 1
     or not exists (select 1 from public.demand_forecasts
                    where hotel_id = current_setting('forecast_test.hotel_b')) then
    raise exception 'Account B must see exactly its own forecast';
  end if;
end $$;

-- User-editable metadata must not confer access to an account's forecasts.
select set_config('request.jwt.claims', jsonb_build_object(
  'role', 'authenticated',
  'user_metadata', jsonb_build_object('account_id', current_setting('forecast_test.account_a')::bigint)
)::text, true);
do $$
begin
  if exists (select 1 from public.demand_forecasts) then
    raise exception 'User metadata unexpectedly confers account access';
  end if;
end $$;

reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
do $$
declare
  statement text;
begin
  foreach statement in array array[
    $q$select * from public.demand_forecasts$q$,
    $q$insert into public.demand_forecasts
       (profile_id, hotel_id, check_in, demand_score, confidence, signals, forecast, context_key)
       values (current_setting('forecast_test.profile_a')::bigint,
               current_setting('forecast_test.hotel_a'), current_date + 1,
               50, 0.2, '[]', '{}', 'forbidden')$q$,
    $q$update public.demand_forecasts set demand_score = 99$q$,
    $q$delete from public.demand_forecasts$q$
  ] loop
    begin
      execute statement;
      raise exception 'Anonymous access unexpectedly succeeded: %', statement;
    exception when insufficient_privilege then null;
    end;
  end loop;
end $$;

reset role;
set local role service_role;
do $$
declare
  affected integer;
begin
  if (select count(*) from public.demand_forecasts
      where profile_id in (current_setting('forecast_test.profile_a')::bigint,
                           current_setting('forecast_test.profile_b')::bigint)) <> 2 then
    raise exception 'Collection service cannot read both account forecasts';
  end if;
  insert into public.demand_forecasts
    (profile_id, hotel_id, check_in, demand_score, confidence, signals, forecast, context_key)
  values (current_setting('forecast_test.profile_a')::bigint,
          current_setting('forecast_test.hotel_a'), current_date + 1,
          50, 0.2, '[]', '{}', 'service-write');
  update public.demand_forecasts set demand_score = 51
  where profile_id = current_setting('forecast_test.profile_a')::bigint
    and check_in = current_date + 1;
  get diagnostics affected = row_count;
  if affected <> 1 then raise exception 'Collection service update failed'; end if;
  delete from public.demand_forecasts
  where profile_id = current_setting('forecast_test.profile_a')::bigint
    and check_in = current_date + 1;
  get diagnostics affected = row_count;
  if affected <> 1 then raise exception 'Collection service delete failed'; end if;
end $$;

reset role;
-- Check rejection of malformed numeric/range/payload values on the trusted
-- write path too, and check that a hotel must be tracked by the given profile.
do $$
declare
  invalid_assignment text;
begin
  foreach invalid_assignment in array array[
    'demand_score = -1', 'demand_score = 101',
    'confidence = -0.01', 'confidence = 1.01',
    'forecast_median = -1', 'forecast_median = ''NaN''::numeric',
    'forecast_median = ''Infinity''::numeric',
    'suggested_low = -1, suggested_high = 100',
    'suggested_low = 120, suggested_high = 100',
    'suggested_low = 100, suggested_high = null',
    'suggested_low = null, suggested_high = 100',
    'signals = ''{}''::jsonb', 'forecast = ''[]''::jsonb',
    'context_key = '''''
  ] loop
    begin
      execute 'update public.demand_forecasts set ' || invalid_assignment ||
        ' where profile_id = current_setting(''forecast_test.profile_a'')::bigint';
      raise exception 'Invalid forecast unexpectedly accepted: %', invalid_assignment;
    exception when check_violation then null;
    end;
  end loop;
  begin
    insert into public.demand_forecasts
      (profile_id, hotel_id, check_in, demand_score, confidence, signals, forecast, context_key)
    values (current_setting('forecast_test.profile_a')::bigint,
            current_setting('forecast_test.hotel_b'), current_date,
            50, 0.2, '[]', '{}', 'untracked-hotel');
    raise exception 'Forecast for an untracked hotel unexpectedly accepted';
  exception when foreign_key_violation then null;
  end;

  delete from public.profile_hotels
  where profile_id = current_setting('forecast_test.profile_a')::bigint
    and hotel_id = current_setting('forecast_test.hotel_a');
  if exists (select 1 from public.demand_forecasts
             where profile_id = current_setting('forecast_test.profile_a')::bigint) then
    raise exception 'Untracking a hotel did not cascade to its forecast';
  end if;
end $$;

rollback;

-- ReviseFlow audit hardening migration

-- 1) Stripe identity mapping + webhook idempotency
create table if not exists public.billing_customer_map (
  user_id uuid primary key,
  stripe_customer_id text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists billing_customer_map_customer_idx
  on public.billing_customer_map (stripe_customer_id);

create table if not exists public.billing_subscription_map (
  stripe_subscription_id text primary key,
  user_id uuid not null,
  stripe_customer_id text,
  status text,
  plan text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists billing_subscription_map_user_idx
  on public.billing_subscription_map (user_id);

create table if not exists public.stripe_webhook_events (
  event_id text primary key,
  event_type text not null,
  processed_at timestamptz not null default now()
);

alter table public.stripe_webhook_events
  add column if not exists status text not null default 'processing',
  add column if not exists last_error text,
  add column if not exists updated_at timestamptz not null default now();

create index if not exists stripe_webhook_events_type_idx
  on public.stripe_webhook_events (event_type, processed_at desc);

-- 2) Atomic AI usage reserve/adjust functions
create or replace function public.consume_ai_tokens(
  p_table text,
  p_user_id uuid,
  p_period_key text,
  p_model text,
  p_add_input integer,
  p_add_output integer,
  p_limit bigint
)
returns table(allowed boolean, used bigint)
language plpgsql
security definer
as $$
declare
  v_used bigint;
  v_sql text;
  v_period_col text;
begin
  if p_table not in ('ai_usage_daily', 'ai_usage_monthly') then
    raise exception 'Unsupported table %', p_table;
  end if;

  v_period_col := case when p_table = 'ai_usage_daily' then 'day' else 'month' end;

  v_sql := format(
    'insert into public.%I (user_id, %I, model, input_tokens, output_tokens, updated_at)
     values ($1, $2, $3, greatest($4, 0), greatest($5, 0), now())
     on conflict (user_id, %I, model)
     do update set
       input_tokens = public.%I.input_tokens + greatest($4, 0),
       output_tokens = public.%I.output_tokens + greatest($5, 0),
       updated_at = now()
     where (public.%I.input_tokens + public.%I.output_tokens + greatest($4, 0) + greatest($5, 0)) <= $6
     returning (input_tokens + output_tokens)::bigint',
    p_table, v_period_col, v_period_col, p_table, p_table, p_table, p_table
  );

  execute v_sql into v_used using p_user_id, p_period_key, p_model, p_add_input, p_add_output, p_limit;

  if v_used is null then
    return query select false, null::bigint;
  else
    return query select true, v_used;
  end if;
end;
$$;

create or replace function public.adjust_ai_tokens(
  p_table text,
  p_user_id uuid,
  p_period_key text,
  p_model text,
  p_delta_input integer,
  p_delta_output integer
)
returns table(used bigint)
language plpgsql
security definer
as $$
declare
  v_used bigint;
  v_sql text;
  v_period_col text;
begin
  if p_table not in ('ai_usage_daily', 'ai_usage_monthly') then
    raise exception 'Unsupported table %', p_table;
  end if;

  v_period_col := case when p_table = 'ai_usage_daily' then 'day' else 'month' end;

  v_sql := format(
    'update public.%I
     set input_tokens = greatest(0, input_tokens + $4),
         output_tokens = greatest(0, output_tokens + $5),
         updated_at = now()
     where user_id = $1 and %I = $2 and model = $3
     returning (input_tokens + output_tokens)::bigint',
    p_table, v_period_col
  );

  execute v_sql into v_used using p_user_id, p_period_key, p_model, p_delta_input, p_delta_output;
  return query select v_used;
end;
$$;

create or replace function public.consume_image_quota(
  p_user_id uuid,
  p_day text,
  p_model text,
  p_inc integer,
  p_limit bigint
)
returns table(allowed boolean, used bigint)
language plpgsql
security definer
as $$
declare
  v_used bigint;
begin
  insert into public.image_usage_daily (user_id, day, model, count, updated_at)
  values (p_user_id, p_day, p_model, greatest(p_inc, 0), now())
  on conflict (user_id, day, model)
  do update set
    count = public.image_usage_daily.count + greatest(p_inc, 0),
    updated_at = now()
  where (public.image_usage_daily.count + greatest(p_inc, 0)) <= p_limit
  returning count::bigint into v_used;

  if v_used is null then
    return query select false, null::bigint;
  else
    return query select true, v_used;
  end if;
end;
$$;


create unique index if not exists ai_usage_daily_user_day_model_uidx
  on public.ai_usage_daily (user_id, day, model);

create unique index if not exists ai_usage_monthly_user_month_model_uidx
  on public.ai_usage_monthly (user_id, month, model);

create unique index if not exists image_usage_daily_user_day_model_uidx
  on public.image_usage_daily (user_id, day, model);


create or replace function public.adjust_image_quota(
  p_user_id uuid,
  p_day text,
  p_model text,
  p_delta integer
)
returns table(used bigint)
language plpgsql
security definer
as $$
declare
  v_used bigint;
begin
  update public.image_usage_daily
  set count = greatest(0, count + p_delta),
      updated_at = now()
  where user_id = p_user_id and day = p_day and model = p_model
  returning count::bigint into v_used;

  return query select coalesce(v_used, 0)::bigint;
end;
$$;

-- Restrict execution of security definer RPCs
revoke all on function public.consume_ai_tokens(text, uuid, text, text, integer, integer, bigint) from public;
revoke all on function public.adjust_ai_tokens(text, uuid, text, text, integer, integer) from public;
revoke all on function public.consume_image_quota(uuid, text, text, integer, bigint) from public;
revoke all on function public.adjust_image_quota(uuid, text, text, integer) from public;

grant execute on function public.consume_ai_tokens(text, uuid, text, text, integer, integer, bigint) to service_role;
grant execute on function public.adjust_ai_tokens(text, uuid, text, text, integer, integer) to service_role;
grant execute on function public.consume_image_quota(uuid, text, text, integer, bigint) to service_role;
grant execute on function public.adjust_image_quota(uuid, text, text, integer) to service_role;

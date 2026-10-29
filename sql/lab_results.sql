-- Lab results imported from TN HMIS reports by the lab extension
-- (POST /api/lab/import → lab_import). Run once in Supabase → SQL Editor.
-- Only the server's secret key reaches it: RLS on, no policies, and the
-- function is not granted to anon/authenticated.

create table if not exists public.lab_results (
  order_no      text        not null,
  panel         text        not null default '',
  test          text        not null,
  pin           text        not null,
  patient_name  text,
  age           text,
  sex           text,
  facility      text,
  ordered_at    timestamptz,
  sample_type   text,
  method        text,
  collected_at  timestamptz,
  reported_at   timestamptz,
  value         text,
  value_num     numeric,
  unit          text,
  ref_range     text,
  abnormal      boolean     not null default false,
  imported_by   text,
  source        text,
  imported_at   timestamptz not null default now(),
  primary key (order_no, panel, test)
);
create index if not exists lab_results_pin on public.lab_results (pin, reported_at desc);
alter table public.lab_results enable row level security;

-- Tests the report lists as not done (e.g. REJECTED).
create table if not exists public.lab_orders (
  order_no     text not null,
  test         text not null,
  pin          text not null,
  status       text,
  imported_at  timestamptz not null default now(),
  primary key (order_no, test)
);
alter table public.lab_orders enable row level security;

create or replace function public.lab_import(p jsonb) returns integer
language plpgsql security definer set search_path = public as $$
declare r jsonb := p->'report'; n integer;
begin
  insert into lab_results as t (order_no, panel, test, pin, patient_name, age, sex, facility, ordered_at,
    sample_type, method, collected_at, reported_at, value, value_num, unit, ref_range, abnormal, imported_by, source)
  select r->>'orderNo', coalesce(x->>'panel', ''), x->>'test', r->'patient'->>'pin', r->'patient'->>'name',
         r->'patient'->>'age', r->'patient'->>'sex', r->>'facility', (r->>'orderedAt')::timestamptz,
         x->>'sampleType', x->>'method', (x->>'collectedAt')::timestamptz, (x->>'reportedAt')::timestamptz,
         x->>'value', (x->>'num')::numeric, x->>'unit', x->>'range', coalesce((x->>'abnormal')::boolean, false),
         p->>'by', p->>'source'
  from jsonb_array_elements(r->'results') x
  on conflict (order_no, panel, test) do update set
    value = excluded.value, value_num = excluded.value_num, unit = excluded.unit, ref_range = excluded.ref_range,
    abnormal = excluded.abnormal, reported_at = excluded.reported_at, imported_by = excluded.imported_by,
    source = excluded.source, imported_at = now();
  get diagnostics n = row_count;
  insert into lab_orders (order_no, test, pin, status)
  select r->>'orderNo', x->>'test', r->'patient'->>'pin', x->>'status' from jsonb_array_elements(coalesce(r->'orders', '[]')) x
  on conflict (order_no, test) do update set status = excluded.status, imported_at = now();
  return n;
end $$;
revoke all on function public.lab_import(jsonb) from public, anon, authenticated;

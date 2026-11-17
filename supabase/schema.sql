-- Run once in a new Supabase project's SQL editor. No service-role key is used by the app.
begin;

create table public.budget_accounts (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  document jsonb not null check (jsonb_typeof(document) = 'object'),
  revision bigint not null default 1,
  updated_at timestamptz not null default now()
);
alter table public.budget_accounts enable row level security;
create policy budget_owner_read on public.budget_accounts for select to authenticated using (owner_id=(select auth.uid()));

create or replace function public.save_budget(p_document jsonb,p_expected_revision bigint)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_revision bigint;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  if jsonb_typeof(p_document)<>'object' or p_document->>'version' is distinct from '1'
    or jsonb_typeof(p_document->'transactions') is distinct from 'array'
    or jsonb_typeof(p_document->'budgets') is distinct from 'object'
    or octet_length(p_document::text)>4000000 then raise exception 'Invalid or oversized budget'; end if;
  if p_expected_revision=0 then
    insert into public.budget_accounts(owner_id,document) values(auth.uid(),p_document)
      on conflict(owner_id) do nothing returning revision into v_revision;
  else
    update public.budget_accounts set document=p_document,revision=revision+1,updated_at=now()
      where owner_id=auth.uid() and revision=p_expected_revision returning revision into v_revision;
  end if;
  if v_revision is null then raise exception 'CLOUD_CONFLICT: Reload cloud data before saving'; end if;
  return v_revision;
end $$;

create table public.households (
  id uuid primary key default gen_random_uuid(),
  name text not null check(length(trim(name)) between 1 and 100),
  owner_id uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);
create table public.household_members (
  household_id uuid references public.households(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  display_name text not null check(length(trim(display_name)) between 1 and 60),
  primary key(household_id,user_id)
);
create table public.household_invites (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  recipient_email text not null,
  expires_at timestamptz not null default (now()+interval '7 days')
);
create table public.household_bills (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  created_by uuid not null references auth.users(id),
  name text not null check(length(trim(name)) between 1 and 100),
  amount bigint not null check(amount>0 and amount<=10000000000),
  due_date date not null,
  method text not null check(method in ('equal','percentage','custom')),
  shares jsonb not null check(jsonb_typeof(shares)='object'),
  settled_ids uuid[] not null default '{}',
  created_at timestamptz not null default now()
);
create index household_member_user on public.household_members(user_id);
create index household_bill_group on public.household_bills(household_id);
create or replace function public.is_household_member(p_household uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.household_members where household_id=p_household and user_id=auth.uid());
$$;
alter table public.households enable row level security;
alter table public.household_members enable row level security;
alter table public.household_invites enable row level security;
alter table public.household_bills enable row level security;
create policy household_read on public.households for select to authenticated using(public.is_household_member(id));
create policy members_read on public.household_members for select to authenticated using(public.is_household_member(household_id));
create policy bills_read on public.household_bills for select to authenticated using(public.is_household_member(household_id));
-- Invites have no direct read or write policy. Only the checked functions below can use them.

create or replace function public.create_household(p_name text,p_display_name text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  insert into public.households(name,owner_id) values(trim(p_name),auth.uid()) returning id into v_id;
  insert into public.household_members values(v_id,auth.uid(),trim(p_display_name));
  return v_id;
end $$;
create or replace function public.invite_housemate(p_household uuid,p_email text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if not exists(select 1 from public.households where id=p_household and owner_id=auth.uid()) then raise exception 'Only the household owner can invite members'; end if;
  if length(trim(p_email))>254 or p_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'Enter a valid recipient email'; end if;
  insert into public.household_invites(household_id,recipient_email) values(p_household,lower(trim(p_email))) returning id into v_id;
  return v_id;
end $$;
create or replace function public.accept_household_invite(p_invite uuid,p_display_name text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_group uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  select household_id into v_group from public.household_invites where id=p_invite
    and recipient_email=lower(auth.jwt()->>'email') and expires_at>now() for update;
  if v_group is null then raise exception 'Invitation expired, unavailable, or intended for another email'; end if;
  perform 1 from public.households where id=v_group for update;
  if (select count(*) from public.household_members where household_id=v_group)>=20 then raise exception 'This household has reached 20 members'; end if;
  insert into public.household_members values(v_group,auth.uid(),trim(p_display_name)) on conflict do nothing;
  delete from public.household_invites where id=p_invite;
  return v_group;
end $$;
create or replace function public.create_household_bill(p_household uuid,p_name text,p_amount bigint,p_due_date date,p_method text,p_shares jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_total bigint; v_key text; v_value jsonb;
begin
  if not public.is_household_member(p_household) then raise exception 'Household access denied'; end if;
  if jsonb_typeof(p_shares) is distinct from 'object' or p_shares='{}'::jsonb then raise exception 'Select at least one participant'; end if;
  v_total=0;
  for v_key,v_value in select * from jsonb_each(p_shares) loop
    if jsonb_typeof(v_value)<>'number' or v_value::text !~ '^[0-9]+$' then raise exception 'Shares must be whole nonnegative pennies'; end if;
    if not exists(select 1 from public.household_members where household_id=p_household and user_id::text=v_key) then raise exception 'Participant is not a household member'; end if;
    v_total=v_total+(v_value::text)::bigint;
  end loop;
  if v_total<>p_amount then raise exception 'Shares must add up to the bill total'; end if;
  insert into public.household_bills(household_id,created_by,name,amount,due_date,method,shares)
    values(p_household,auth.uid(),trim(p_name),p_amount,p_due_date,p_method,p_shares) returning id into v_id;
  return v_id;
end $$;
create or replace function public.settle_household_share(p_bill uuid,p_settled boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare v_bill public.household_bills;
begin
  select * into v_bill from public.household_bills where id=p_bill for update;
  if not public.is_household_member(v_bill.household_id) or not (v_bill.shares ? auth.uid()::text) then raise exception 'You can only settle your own share'; end if;
  update public.household_bills set settled_ids=case when p_settled then array_append(array_remove(settled_ids,auth.uid()),auth.uid()) else array_remove(settled_ids,auth.uid()) end where id=p_bill;
end $$;
create or replace function public.delete_household_bill(p_bill uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_bill public.household_bills;
begin
  select * into v_bill from public.household_bills where id=p_bill for update;
  if v_bill.created_by is distinct from auth.uid() and not exists(select 1 from public.households where id=v_bill.household_id and owner_id=auth.uid()) then raise exception 'Only the recorder or household owner may delete this bill'; end if;
  if cardinality(v_bill.settled_ids)>0 then raise exception 'Settled bills are retained as payment history'; end if;
  delete from public.household_bills where id=p_bill;
end $$;

create table public.support_snapshots (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  recipient_email text not null,
  summary jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);
alter table public.support_snapshots enable row level security;
create policy snapshot_owner_read on public.support_snapshots for select to authenticated using(owner_id=(select auth.uid()));
create policy snapshot_recipient_read on public.support_snapshots for select to authenticated
  using(recipient_email=lower((select auth.jwt()->>'email')) and revoked_at is null and expires_at>now());
create index snapshot_owner on public.support_snapshots(owner_id);
create or replace function public.preview_support_snapshot(p_categories text[],p_from date,p_to date)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_doc jsonb; v_revision bigint; v_totals jsonb;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  if cardinality(p_categories) is null or cardinality(p_categories)=0 or cardinality(p_categories)>7
    or exists(select 1 from unnest(p_categories) as c where c is null or c not in ('Groceries','Transport','Eating out','Shopping','Entertainment','Study','Other')) then raise exception 'Choose valid categories'; end if;
  if p_from is null or p_to is null or p_from>p_to then raise exception 'Choose a valid date range'; end if;
  select document,revision into v_doc,v_revision from public.budget_accounts where owner_id=auth.uid();
  if v_doc is null then raise exception 'Save your cloud budget before sharing'; end if;
  select coalesce(jsonb_object_agg(category,amount),'{}'::jsonb) into v_totals from (
    select c as category,coalesce((select sum((t->>'amount')::bigint) from jsonb_array_elements(v_doc->'transactions') t
      where t->>'type'='expense' and t->>'category'=c and t->>'date'>=p_from::text and t->>'date'<=p_to::text),0) as amount
    from (select distinct unnest(p_categories) as c) cats
  ) totals;
  return jsonb_build_object('revision',v_revision,'summary',jsonb_build_object('from',p_from,'to',p_to,'totals',v_totals));
end $$;
create or replace function public.create_support_snapshot(p_categories text[],p_from date,p_to date,p_recipient text,p_days integer,p_expected_revision bigint)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_preview jsonb; v_id uuid;
begin
  if p_days is null or p_days<1 or p_days>30 then raise exception 'Choose 1 to 30 days'; end if;
  if length(trim(p_recipient))>254 or p_recipient !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'Enter a valid recipient email'; end if;
  -- Lock the source record so the confirmed preview and saved summary cannot race a budget save.
  perform 1 from public.budget_accounts where owner_id=auth.uid() for update;
  v_preview=public.preview_support_snapshot(p_categories,p_from,p_to);
  if (v_preview->>'revision')::bigint is distinct from p_expected_revision then raise exception 'Budget changed. Preview the summary again'; end if;
  insert into public.support_snapshots(owner_id,recipient_email,summary,expires_at)
    values(auth.uid(),lower(trim(p_recipient)),v_preview->'summary',now()+make_interval(days=>p_days)) returning id into v_id;
  return v_id;
end $$;
create or replace function public.revoke_support_snapshot(p_snapshot uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.support_snapshots set revoked_at=now() where id=p_snapshot and owner_id=auth.uid();
  if not found then raise exception 'Snapshot unavailable'; end if;
end $$;

-- No anonymous reads or direct client writes, including on private documents and invitation records.
revoke all on public.budget_accounts,public.households,public.household_members,public.household_invites,public.household_bills,public.support_snapshots from anon,authenticated;
grant select on public.budget_accounts,public.households,public.household_members,public.household_bills,public.support_snapshots to authenticated;
-- Postgres functions are executable by PUBLIC by default. Remove that default for every application RPC.
revoke all on function public.save_budget(jsonb,bigint),public.is_household_member(uuid),public.create_household(text,text),public.invite_housemate(uuid,text),public.accept_household_invite(uuid,text),public.create_household_bill(uuid,text,bigint,date,text,jsonb),public.settle_household_share(uuid,boolean),public.delete_household_bill(uuid),public.preview_support_snapshot(text[],date,date),public.create_support_snapshot(text[],date,date,text,integer,bigint),public.revoke_support_snapshot(uuid) from public,anon;
grant execute on function public.save_budget(jsonb,bigint),public.is_household_member(uuid),public.create_household(text,text),public.invite_housemate(uuid,text),public.accept_household_invite(uuid,text),public.create_household_bill(uuid,text,bigint,date,text,jsonb),public.settle_household_share(uuid,boolean),public.delete_household_bill(uuid),public.preview_support_snapshot(text[],date,date),public.create_support_snapshot(text[],date,date,text,integer,bigint),public.revoke_support_snapshot(uuid) to authenticated;
commit;

-- Nur nach DB-Go. Nicht ausführen, bis Dominik das explizit freigibt.
-- Paket 11: Name beim Einladen, Standard-Anzeigename beim Annehmen.
-- Idempotent. Die App läuft ohne diese Änderung weiter: die alte RPC ignoriert «name»,
-- Einladungen zeigen dann wie bisher die E-Mail-Adresse.
-- Grundlage: docs/supabase/paket-8-freigabe.sql (invite_to_trip, accept_trip_invite*, list_trip_people).
-- Signaturen unverändert gegenüber Paket 8.

begin;

alter table public.trip_invites add column if not exists display_name text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'trip_invites_display_name_len') then
    alter table public.trip_invites add constraint trip_invites_display_name_len
      check (display_name is null or char_length(display_name) <= 60);
  end if;
end $$;

create or replace function public.invite_to_trip(p_trip_id uuid, p_invites jsonb)
returns table (email text, result text, invite_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid   uuid := (select auth.uid());
  v_item  jsonb;
  v_email text;
  v_role  text;
  v_name  text;
  v_target uuid;
  v_inv   uuid;
  v_used  integer;
begin
  if v_uid is null then raise exception 'Nicht angemeldet' using errcode = '28000'; end if;
  if not private.has_trip_role(p_trip_id, array['owner']) then
    raise exception 'Nur der Besitzer kann Freigaben verwalten' using errcode = '42501';
  end if;
  if p_invites is null or jsonb_typeof(p_invites) <> 'array' or jsonb_array_length(p_invites) > 20 then
    raise exception 'Höchstens 20 Adressen auf einmal' using errcode = '22023';
  end if;

  for v_item in select value from jsonb_array_elements(p_invites) loop
    v_email := lower(btrim(coalesce(v_item ->> 'email', '')));
    v_role  := coalesce(v_item ->> 'role', 'viewer');
    v_name  := nullif(left(btrim(coalesce(v_item ->> 'name', '')), 60), '');
    v_inv   := null;

    if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or v_role not in ('editor', 'viewer') then
      email := v_email; result := 'invalid'; invite_id := null; return next; continue;
    end if;

    select count(*) into v_used from private.invite_lookups l
    where l.user_id = v_uid and l.at > now() - interval '24 hours';
    if v_used >= 50 then
      email := v_email; result := 'rate_limited'; invite_id := null; return next; continue;
    end if;
    insert into private.invite_lookups (user_id) values (v_uid);

    select u.id into v_target from auth.users u where lower(u.email) = v_email limit 1;

    if v_target is null then
      email := v_email; result := 'not_registered'; invite_id := null; return next; continue;
    end if;
    if v_target = v_uid then
      email := v_email; result := 'self'; invite_id := null; return next; continue;
    end if;
    if exists (select 1 from public.trip_members m where m.trip_id = p_trip_id and m.user_id = v_target) then
      email := v_email; result := 'already_member'; invite_id := null; return next; continue;
    end if;

    update public.trip_invites i
       set role = v_role,
           invited_user_id = v_target,
           expires_at = now() + interval '14 days',
           display_name = coalesce(v_name, i.display_name)
     where i.trip_id = p_trip_id and lower(i.email) = v_email
       and i.accepted_at is null and i.declined_at is null and i.revoked_at is null
    returning i.id into v_inv;

    if v_inv is not null then
      email := v_email; result := 'updated'; invite_id := v_inv; return next; continue;
    end if;

    insert into public.trip_invites (trip_id, email, role, created_by, invited_user_id, display_name)
    values (p_trip_id, v_email, v_role, v_uid, v_target, v_name)
    returning id into v_inv;
    email := v_email; result := 'invited'; invite_id := v_inv; return next;
  end loop;
end;
$$;

create or replace function public.accept_trip_invite_by_id(p_invite_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inv   public.trip_invites%rowtype;
  v_uid   uuid := (select auth.uid());
  v_email text := lower(coalesce((select auth.jwt() ->> 'email'), ''));
begin
  if v_uid is null then raise exception 'Nicht angemeldet' using errcode = '28000'; end if;
  select * into v_inv from public.trip_invites where id = p_invite_id for update;
  if not found or v_inv.accepted_at is not null or v_inv.declined_at is not null
     or v_inv.revoked_at is not null or v_inv.expires_at < now() then
    raise exception 'Einladung ungueltig oder abgelaufen' using errcode = 'P0001';
  end if;
  if not (v_inv.invited_user_id = v_uid or lower(v_inv.email) = v_email) then
    raise exception 'Einladung gilt fuer eine andere E-Mail-Adresse' using errcode = '42501';
  end if;
  insert into public.trip_members (trip_id, user_id, role)
  values (v_inv.trip_id, v_uid, v_inv.role)
  on conflict (trip_id, user_id) do nothing;
  update public.profiles p
     set display_name = nullif(btrim(v_inv.display_name), '')
   where p.id = v_uid
     and nullif(btrim(coalesce(p.display_name, '')), '') is null
     and nullif(btrim(coalesce(v_inv.display_name, '')), '') is not null;
  update public.trip_invites set accepted_at = now(), accepted_by = v_uid where id = v_inv.id;
  return v_inv.trip_id;
end;
$$;

create or replace function public.accept_trip_invite(p_token text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inv   public.trip_invites%rowtype;
  v_uid   uuid := (select auth.uid());
  v_email text := lower(coalesce((select auth.jwt() ->> 'email'), ''));
begin
  if v_uid is null then raise exception 'Nicht angemeldet' using errcode = '28000'; end if;
  select * into v_inv from public.trip_invites where token = p_token for update;
  if not found or v_inv.accepted_at is not null or v_inv.declined_at is not null
     or v_inv.revoked_at is not null or v_inv.expires_at < now() then
    raise exception 'Einladung ungueltig oder abgelaufen' using errcode = 'P0001';
  end if;
  if not (v_inv.invited_user_id = v_uid or lower(v_inv.email) = v_email) then
    raise exception 'Einladung gilt fuer eine andere E-Mail-Adresse' using errcode = '42501';
  end if;
  insert into public.trip_members (trip_id, user_id, role)
  values (v_inv.trip_id, v_uid, v_inv.role)
  on conflict (trip_id, user_id) do nothing;
  update public.profiles p
     set display_name = nullif(btrim(v_inv.display_name), '')
   where p.id = v_uid
     and nullif(btrim(coalesce(p.display_name, '')), '') is null
     and nullif(btrim(coalesce(v_inv.display_name, '')), '') is not null;
  update public.trip_invites set accepted_at = now(), accepted_by = v_uid where id = v_inv.id;
  return v_inv.trip_id;
end;
$$;

create or replace function public.list_trip_people(p_trip_id uuid)
returns table (
  person_kind text, user_id uuid, invite_id uuid, display_name text, avatar_color text,
  role text, status text, email text, since timestamptz, expires_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid   uuid := (select auth.uid());
  v_owner boolean;
begin
  if v_uid is null or not private.is_trip_member(p_trip_id) then
    raise exception 'Kein Zugriff' using errcode = '42501';
  end if;
  v_owner := private.has_trip_role(p_trip_id, array['owner']);

  return query
  select 'member'::text, m.user_id, null::uuid, nullif(btrim(p.display_name), ''), p.avatar_color,
         m.role, 'aktiv'::text,
         case when v_owner then (select u.email::text from auth.users u where u.id = m.user_id) end,
         m.created_at, null::timestamptz
  from public.trip_members m
  left join public.profiles p on p.id = m.user_id
  where m.trip_id = p_trip_id;

  if v_owner then
    return query
    select 'invite'::text, i.invited_user_id, i.id,
           coalesce(nullif(btrim(p.display_name), ''), i.display_name), p.avatar_color,
           i.role, case when i.expires_at > now() then 'eingeladen' else 'abgelaufen' end,
           i.email, i.created_at, i.expires_at
    from public.trip_invites i
    left join public.profiles p on p.id = i.invited_user_id
    where i.trip_id = p_trip_id
      and i.accepted_at is null and i.declined_at is null and i.revoked_at is null;
  end if;

  return query
  select 'former'::text, a.uid, null::uuid, nullif(btrim(p.display_name), ''), p.avatar_color,
         null::text, 'ehemalig'::text, null::text, null::timestamptz, null::timestamptz
  from (
    select w.created_by as uid from public.waypoints w where w.trip_id = p_trip_id
    union select n.created_by from public.notes n where n.trip_id = p_trip_id
    union select md.created_by from public.media md where md.trip_id = p_trip_id
  ) a
  left join public.profiles p on p.id = a.uid
  where not exists (select 1 from public.trip_members m where m.trip_id = p_trip_id and m.user_id = a.uid);
end;
$$;

commit;

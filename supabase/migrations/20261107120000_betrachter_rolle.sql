-- VacRecap: Rolle «Betrachter» (observer) – strikt lesend (2026).
-- Erweitert die bestehenden CHECK-Constraints unter den Originalnamen
-- trip_members_role_check / trip_invites_role_check (keine parallelen *_betrachter_v1).
-- RLS: wie Paket-8; observer hat nur SELECT (INSERT/UPDATE/DELETE schlagen fehl, kein Zusatz
-- «not observer» nötig). RPCs: observer bei Einladungen und Rollenwechsel erlaubt.
--
-- ROLLBACK — ersetzt genau den vorherigen Live-Stand (Paket-8 / ohne observer):
/*
begin;

-- Bestehende observer-Zeilen vor engem CHECK auf viewer demoten (sonst schlägt add constraint fehl)
update public.trip_members set role = 'viewer' where role = 'observer';
update public.trip_invites set role = 'viewer' where role = 'observer';

alter table public.trip_members drop constraint if exists trip_members_role_check;
alter table public.trip_members
  add constraint trip_members_role_check
  check (role in ('owner', 'editor', 'viewer'));

alter table public.trip_invites drop constraint if exists trip_invites_role_check;
alter table public.trip_invites
  add constraint trip_invites_role_check
  check (role in ('editor', 'viewer'));

create or replace function private.guard_contributor_place_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then return new; end if;
  if old.deleted_at is null and new.deleted_at is not null
     and private.has_trip_role(new.trip_id, array['viewer'])
     and (
       exists (select 1 from public.media m
               where m.waypoint_id = new.id and m.deleted_at is null and m.created_by <> v_uid)
       or exists (select 1 from public.notes n
                  where n.waypoint_id = new.id and n.deleted_at is null and n.created_by <> v_uid)
     ) then
    raise exception 'An diesem Ort hängen Inhalte von anderen' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop policy if exists waypoints_insert on public.waypoints;
create policy waypoints_insert on public.waypoints for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and (select private.has_trip_role(trip_id, array['owner', 'editor', 'viewer']))
  );
drop policy if exists waypoints_update on public.waypoints;
create policy waypoints_update on public.waypoints for update to authenticated
  using (
    (select private.has_trip_role(trip_id, array['owner', 'editor']))
    or (created_by = (select auth.uid()) and (select private.has_trip_role(trip_id, array['viewer'])))
  )
  with check (
    (select private.has_trip_role(trip_id, array['owner', 'editor']))
    or (created_by = (select auth.uid()) and (select private.has_trip_role(trip_id, array['viewer'])))
  );
drop policy if exists waypoints_delete on public.waypoints;
create policy waypoints_delete on public.waypoints for delete to authenticated
  using (
    (select private.has_trip_role(trip_id, array['owner', 'editor']))
    or (created_by = (select auth.uid()) and (select private.has_trip_role(trip_id, array['viewer'])))
  );

drop policy if exists notes_insert on public.notes;
create policy notes_insert on public.notes for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and (select private.has_trip_role(trip_id, array['owner', 'editor', 'viewer']))
  );
drop policy if exists notes_update on public.notes;
create policy notes_update on public.notes for update to authenticated
  using (
    (select private.has_trip_role(trip_id, array['owner', 'editor']))
    or (created_by = (select auth.uid()) and (select private.has_trip_role(trip_id, array['viewer'])))
  )
  with check (
    (select private.has_trip_role(trip_id, array['owner', 'editor']))
    or (created_by = (select auth.uid()) and (select private.has_trip_role(trip_id, array['viewer'])))
  );
drop policy if exists notes_delete on public.notes;
create policy notes_delete on public.notes for delete to authenticated
  using (
    (select private.has_trip_role(trip_id, array['owner', 'editor']))
    or (created_by = (select auth.uid()) and (select private.has_trip_role(trip_id, array['viewer'])))
  );

drop policy if exists media_insert on public.media;
create policy media_insert on public.media for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and (select private.has_trip_role(trip_id, array['owner', 'editor', 'viewer']))
  );
drop policy if exists media_update on public.media;
create policy media_update on public.media for update to authenticated
  using (
    (select private.has_trip_role(trip_id, array['owner', 'editor']))
    or (created_by = (select auth.uid()) and (select private.has_trip_role(trip_id, array['viewer'])))
  )
  with check (
    (select private.has_trip_role(trip_id, array['owner', 'editor']))
    or (created_by = (select auth.uid()) and (select private.has_trip_role(trip_id, array['viewer'])))
  );
drop policy if exists media_delete on public.media;
create policy media_delete on public.media for delete to authenticated
  using (
    (select private.has_trip_role(trip_id, array['owner', 'editor']))
    or (created_by = (select auth.uid()) and (select private.has_trip_role(trip_id, array['viewer'])))
  );

drop policy if exists media_objects_insert on storage.objects;
create policy media_objects_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = any (array['media-originals', 'media-thumbs'])
    and (select private.has_trip_role(private.trip_id_from_path(name), array['owner', 'editor', 'viewer']))
  );
drop policy if exists media_objects_update on storage.objects;
create policy media_objects_update on storage.objects for update to authenticated
  using (
    bucket_id = any (array['media-originals', 'media-thumbs'])
    and (
      (select private.has_trip_role(private.trip_id_from_path(name), array['owner', 'editor']))
      or (owner_id = (select auth.uid())::text
          and (select private.has_trip_role(private.trip_id_from_path(name), array['viewer'])))
    )
  )
  with check (
    bucket_id = any (array['media-originals', 'media-thumbs'])
    and (
      (select private.has_trip_role(private.trip_id_from_path(name), array['owner', 'editor']))
      or (owner_id = (select auth.uid())::text
          and (select private.has_trip_role(private.trip_id_from_path(name), array['viewer'])))
    )
  );
drop policy if exists media_objects_delete on storage.objects;
create policy media_objects_delete on storage.objects for delete to authenticated
  using (
    bucket_id = any (array['media-originals', 'media-thumbs'])
    and (
      (select private.has_trip_role(private.trip_id_from_path(name), array['owner', 'editor']))
      or (owner_id = (select auth.uid())::text
          and (select private.has_trip_role(private.trip_id_from_path(name), array['viewer'])))
    )
  );

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
       set role = v_role, invited_user_id = v_target, expires_at = now() + interval '14 days'
     where i.trip_id = p_trip_id and lower(i.email) = v_email
       and i.accepted_at is null and i.declined_at is null and i.revoked_at is null
    returning i.id into v_inv;

    if v_inv is not null then
      email := v_email; result := 'updated'; invite_id := v_inv; return next; continue;
    end if;

    insert into public.trip_invites (trip_id, email, role, created_by, invited_user_id)
    values (p_trip_id, v_email, v_role, v_uid, v_target)
    returning id into v_inv;
    email := v_email; result := 'invited'; invite_id := v_inv; return next;
  end loop;
end;
$$;

create or replace function public.set_trip_access_role(
  p_trip_id uuid, p_role text, p_user_id uuid default null, p_invite_id uuid default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_n   integer;
begin
  if v_uid is null then raise exception 'Nicht angemeldet' using errcode = '28000'; end if;
  if not private.has_trip_role(p_trip_id, array['owner']) then
    raise exception 'Nur der Besitzer kann Freigaben verwalten' using errcode = '42501';
  end if;
  if p_role not in ('editor', 'viewer') then
    raise exception 'Unbekannte Rolle' using errcode = '22023';
  end if;
  if (p_user_id is null) = (p_invite_id is null) then
    raise exception 'Genau eine Person oder Einladung angeben' using errcode = '22023';
  end if;
  if p_user_id is not null then
    if p_user_id = v_uid then raise exception 'Eigene Rolle nicht änderbar' using errcode = '42501'; end if;
    update public.trip_members m set role = p_role
     where m.trip_id = p_trip_id and m.user_id = p_user_id and m.role <> 'owner';
  else
    update public.trip_invites i set role = p_role
     where i.id = p_invite_id and i.trip_id = p_trip_id
       and i.accepted_at is null and i.declined_at is null and i.revoked_at is null;
  end if;
  get diagnostics v_n = row_count;
  if v_n = 0 then raise exception 'Nicht gefunden' using errcode = 'P0002'; end if;
end;
$$;

commit;
*/

begin;

-- Alte parallele Constraint-Namen aus fehlgeschlagenen Versuchen entfernen
alter table public.trip_members drop constraint if exists trip_members_role_betrachter_v1;
alter table public.trip_invites drop constraint if exists trip_invites_role_betrachter_v1;

-- Originale CHECK-Namen: Werte ersetzen (observer statt zusätzlicher Constraint)
alter table public.trip_members drop constraint if exists trip_members_role_check;
alter table public.trip_members
  add constraint trip_members_role_check
  check (role in ('owner', 'editor', 'viewer', 'observer'));

alter table public.trip_invites drop constraint if exists trip_invites_role_check;
alter table public.trip_invites
  add constraint trip_invites_role_check
  check (role in ('editor', 'viewer', 'observer'));

-- Wie Paket-8: Beitragender-Schutz; RLS verhindert Schreiben als observer
create or replace function private.guard_contributor_place_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then return new; end if;
  if old.deleted_at is null and new.deleted_at is not null
     and private.has_trip_role(new.trip_id, array['viewer'])
     and (
       exists (select 1 from public.media m
               where m.waypoint_id = new.id and m.deleted_at is null and m.created_by <> v_uid)
       or exists (select 1 from public.notes n
                  where n.waypoint_id = new.id and n.deleted_at is null and n.created_by <> v_uid)
     ) then
    raise exception 'An diesem Ort hängen Inhalte von anderen' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

-- waypoints / notes / media / storage: identisch Paket-8 (ohne redundanten «not observer»)
drop policy if exists waypoints_insert on public.waypoints;
create policy waypoints_insert on public.waypoints for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and (select private.has_trip_role(trip_id, array['owner', 'editor', 'viewer']))
  );
drop policy if exists waypoints_update on public.waypoints;
create policy waypoints_update on public.waypoints for update to authenticated
  using (
    (select private.has_trip_role(trip_id, array['owner', 'editor']))
    or (created_by = (select auth.uid()) and (select private.has_trip_role(trip_id, array['viewer'])))
  )
  with check (
    (select private.has_trip_role(trip_id, array['owner', 'editor']))
    or (created_by = (select auth.uid()) and (select private.has_trip_role(trip_id, array['viewer'])))
  );
drop policy if exists waypoints_delete on public.waypoints;
create policy waypoints_delete on public.waypoints for delete to authenticated
  using (
    (select private.has_trip_role(trip_id, array['owner', 'editor']))
    or (created_by = (select auth.uid()) and (select private.has_trip_role(trip_id, array['viewer'])))
  );

drop policy if exists notes_insert on public.notes;
create policy notes_insert on public.notes for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and (select private.has_trip_role(trip_id, array['owner', 'editor', 'viewer']))
  );
drop policy if exists notes_update on public.notes;
create policy notes_update on public.notes for update to authenticated
  using (
    (select private.has_trip_role(trip_id, array['owner', 'editor']))
    or (created_by = (select auth.uid()) and (select private.has_trip_role(trip_id, array['viewer'])))
  )
  with check (
    (select private.has_trip_role(trip_id, array['owner', 'editor']))
    or (created_by = (select auth.uid()) and (select private.has_trip_role(trip_id, array['viewer'])))
  );
drop policy if exists notes_delete on public.notes;
create policy notes_delete on public.notes for delete to authenticated
  using (
    (select private.has_trip_role(trip_id, array['owner', 'editor']))
    or (created_by = (select auth.uid()) and (select private.has_trip_role(trip_id, array['viewer'])))
  );

drop policy if exists media_insert on public.media;
create policy media_insert on public.media for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and (select private.has_trip_role(trip_id, array['owner', 'editor', 'viewer']))
  );
drop policy if exists media_update on public.media;
create policy media_update on public.media for update to authenticated
  using (
    (select private.has_trip_role(trip_id, array['owner', 'editor']))
    or (created_by = (select auth.uid()) and (select private.has_trip_role(trip_id, array['viewer'])))
  )
  with check (
    (select private.has_trip_role(trip_id, array['owner', 'editor']))
    or (created_by = (select auth.uid()) and (select private.has_trip_role(trip_id, array['viewer'])))
  );
drop policy if exists media_delete on public.media;
create policy media_delete on public.media for delete to authenticated
  using (
    (select private.has_trip_role(trip_id, array['owner', 'editor']))
    or (created_by = (select auth.uid()) and (select private.has_trip_role(trip_id, array['viewer'])))
  );

drop policy if exists media_objects_insert on storage.objects;
create policy media_objects_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = any (array['media-originals', 'media-thumbs'])
    and (select private.has_trip_role(private.trip_id_from_path(name), array['owner', 'editor', 'viewer']))
  );
drop policy if exists media_objects_update on storage.objects;
create policy media_objects_update on storage.objects for update to authenticated
  using (
    bucket_id = any (array['media-originals', 'media-thumbs'])
    and (
      (select private.has_trip_role(private.trip_id_from_path(name), array['owner', 'editor']))
      or (owner_id = (select auth.uid())::text
          and (select private.has_trip_role(private.trip_id_from_path(name), array['viewer'])))
    )
  )
  with check (
    bucket_id = any (array['media-originals', 'media-thumbs'])
    and (
      (select private.has_trip_role(private.trip_id_from_path(name), array['owner', 'editor']))
      or (owner_id = (select auth.uid())::text
          and (select private.has_trip_role(private.trip_id_from_path(name), array['viewer'])))
    )
  );
drop policy if exists media_objects_delete on storage.objects;
create policy media_objects_delete on storage.objects for delete to authenticated
  using (
    bucket_id = any (array['media-originals', 'media-thumbs'])
    and (
      (select private.has_trip_role(private.trip_id_from_path(name), array['owner', 'editor']))
      or (owner_id = (select auth.uid())::text
          and (select private.has_trip_role(private.trip_id_from_path(name), array['viewer'])))
    )
  );

-- RPCs: Namen optional (display_name), observer erlaubt
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

    if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or v_role not in ('editor', 'viewer', 'observer') then
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

create or replace function public.set_trip_access_role(
  p_trip_id uuid, p_role text, p_user_id uuid default null, p_invite_id uuid default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_n   integer;
begin
  if v_uid is null then raise exception 'Nicht angemeldet' using errcode = '28000'; end if;
  if not private.has_trip_role(p_trip_id, array['owner']) then
    raise exception 'Nur der Besitzer kann Freigaben verwalten' using errcode = '42501';
  end if;
  if p_role not in ('editor', 'viewer', 'observer') then
    raise exception 'Unbekannte Rolle' using errcode = '22023';
  end if;
  if (p_user_id is null) = (p_invite_id is null) then
    raise exception 'Genau eine Person oder Einladung angeben' using errcode = '22023';
  end if;
  if p_user_id is not null then
    if p_user_id = v_uid then raise exception 'Eigene Rolle nicht änderbar' using errcode = '42501'; end if;
    update public.trip_members m set role = p_role
     where m.trip_id = p_trip_id and m.user_id = p_user_id and m.role <> 'owner';
  else
    update public.trip_invites i set role = p_role
     where i.id = p_invite_id and i.trip_id = p_trip_id
       and i.accepted_at is null and i.declined_at is null and i.revoked_at is null;
  end if;
  get diagnostics v_n = row_count;
  if v_n = 0 then raise exception 'Nicht gefunden' using errcode = 'P0002'; end if;
end;
$$;

commit;

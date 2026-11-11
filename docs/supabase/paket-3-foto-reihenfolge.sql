-- Paket 3: Fotos per Ziehen sortieren.
-- Diese Datei wurde NICHT ausgeführt. Einmal im Supabase-SQL-Editor ausführen,
-- erst nach ausdrücklichem DB-Go. Nicht gegen eine Live-Datenbank anwenden.
-- Idempotent. Die App läuft ohne diese Änderung weiter: sie sortiert dann nach
-- Aufnahmezeit und meldet beim Ziehen, dass die Reihenfolge noch nicht verfügbar ist.
-- Grundlage: private.has_trip_role aus Paket 8. taken_at wird hier nie geschrieben.

begin;

alter table public.media
  add column if not exists sort_order integer;

create index if not exists media_waypoint_sort_idx
  on public.media (waypoint_id, sort_order, taken_at)
  where deleted_at is null;

-- Beitragende dürfen sort_order nicht über ein direktes Update ändern.
-- Die Spalte taken_at bleibt hier ausdrücklich unangetastet.
create or replace function private.guard_media_sort_order()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.sort_order is distinct from old.sort_order then
    if (select auth.uid()) is null
       or new.trip_id is null
       or not private.has_trip_role(new.trip_id, array['owner', 'editor']) then
      raise exception 'Dafür fehlt die Berechtigung.' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists media_guard_sort_order on public.media;
create trigger media_guard_sort_order
  before update on public.media
  for each row execute function private.guard_media_sort_order();

-- p_reset setzt sort_order des Orts auf null.
-- Sonst bekommt die Liste die Ränge 1..n. Medien des Orts, die nicht in der
-- Liste stehen, verlieren ihren Rang. taken_at wird nicht gesetzt.
create or replace function public.set_place_media_order(
  p_waypoint_id uuid,
  p_media_ids uuid[],
  p_reset boolean default false
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_trip uuid;
begin
  if v_uid is null then
    raise exception 'Nicht angemeldet' using errcode = '28000';
  end if;
  select w.trip_id into v_trip
  from public.waypoints w
  where w.id = p_waypoint_id
    and w.deleted_at is null;
  if v_trip is null then
    raise exception 'Ort nicht gefunden' using errcode = 'P0002';
  end if;
  if not private.has_trip_role(v_trip, array['owner', 'editor']) then
    raise exception 'Dafür fehlt die Berechtigung.' using errcode = '42501';
  end if;

  if coalesce(p_reset, false) then
    update public.media
       set sort_order = null
     where waypoint_id = p_waypoint_id
       and trip_id = v_trip
       and deleted_at is null
       and sort_order is not null;
    return;
  end if;

  if p_media_ids is null or cardinality(p_media_ids) = 0 then
    raise exception 'Die Reihenfolge ist leer' using errcode = '22023';
  end if;
  if cardinality(p_media_ids) > 500 then
    raise exception 'Zu viele Fotos' using errcode = '22023';
  end if;
  if exists (
    select 1
    from unnest(p_media_ids) as t(id)
    group by t.id
    having count(*) > 1
  ) then
    raise exception 'Doppelte Fotos in der Reihenfolge' using errcode = '22023';
  end if;
  if exists (
    select 1
    from unnest(p_media_ids) as t(id)
    where not exists (
      select 1
      from public.media m
      where m.id = t.id
        and m.waypoint_id = p_waypoint_id
        and m.trip_id = v_trip
        and m.deleted_at is null
    )
  ) then
    raise exception 'Die Fotos gehören nicht zu diesem Ort' using errcode = 'P0001';
  end if;

  update public.media m
     set sort_order = null
   where m.waypoint_id = p_waypoint_id
     and m.trip_id = v_trip
     and m.deleted_at is null
     and not (m.id = any (p_media_ids))
     and m.sort_order is not null;

  update public.media m
     set sort_order = t.ord::integer
    from unnest(p_media_ids) with ordinality as t(id, ord)
   where m.id = t.id
     and m.waypoint_id = p_waypoint_id
     and m.trip_id = v_trip
     and m.deleted_at is null;
end;
$$;

revoke all on function private.guard_media_sort_order() from public, anon, authenticated;
revoke all on function public.set_place_media_order(uuid, uuid[], boolean) from public, anon;
grant execute on function public.set_place_media_order(uuid, uuid[], boolean) to authenticated;

commit;

notify pgrst, 'reload schema';

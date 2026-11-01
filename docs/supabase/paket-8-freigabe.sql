-- Paket 8 «Freigabe» (Build 65) · docs/supabase/paket-8-freigabe.sql
-- Erst NACH dem Merge und nur mit Dominiks DB-Go im Supabase SQL Editor ausführen,
-- als EIN Block (alles markieren, Run). Die Datei ist idempotent: ein zweiter Lauf
-- ändert nichts mehr und bricht nicht ab.
-- Grundlage: DB-Ist-Stand vom 01.11.2026, nur gelesen (Projekt hgboqdovlfeuqfhfeykn).
--
-- Rollen (DB-Wert → App-Text):
--   owner  → Besitzer       alles, einziger der Freigaben verwaltet und die Reise löscht
--   editor → Mitbearbeiter  wie Besitzer (auch Fremdes ändern, Entwürfe/Recap umsetzen),
--                           aber keine Freigaben und kein Löschen der Reise
--   viewer → Beitragender   eigenes hinzufügen, eigenes ändern/löschen, Fremdes nur ansehen,
--                           keine Entwürfe/Recap, keine Freigaben
-- Die DB-Werte bleiben owner/editor/viewer (Check-Constraints unverändert).
--
-- Inhalt:
--   1  Spalten: profiles.avatar_color, trip_invites.invited_user_id/declined_at/revoked_at,
--      updated_by an trips/waypoints/notes/media/trip_recaps
--   2  Hilfsfunktionen + Trigger (Farbe, updated_by, Schutz beim Löschen eines Orts)
--   3  RLS neu: waypoints/notes/media + storage.objects (Beitragender), trip_members/trip_invites
--      (Schreiben nur noch über RPCs)
--   4  Presence-Tabelle «X bearbeitet gerade»
--   5  RPCs (Einladen, Einladungen lesen, Beitreten, Ablehnen, Rolle ändern, Entziehen,
--      Verlassen, Personen der Reise, Presence)
--   6  Rechte (GRANT/REVOKE)
--   Am Ende: auskommentierte Prüfabfragen

begin;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1 · Spalten
-- ─────────────────────────────────────────────────────────────────────────────

-- Farbe des Mitglieder-Kreises (weißer Anfangsbuchstabe auf dieser Farbe)
alter table public.profiles add column if not exists avatar_color text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_avatar_color_check') then
    alter table public.profiles add constraint profiles_avatar_color_check
      check (avatar_color is null or avatar_color ~ '^#[0-9A-Fa-f]{6}$');
  end if;
end $$;

-- Einladungen: aufgelöstes Konto, Ablehnen, Zurückziehen
alter table public.trip_invites add column if not exists invited_user_id uuid references auth.users(id) on delete cascade;
alter table public.trip_invites add column if not exists declined_at timestamptz;
alter table public.trip_invites add column if not exists revoked_at timestamptz;
create index if not exists trip_invites_invited_user_idx on public.trip_invites (invited_user_id);

-- Alte doppelte offene Einladungen (gleiche Reise + Adresse) zurückziehen, die neueste bleibt.
update public.trip_invites i set revoked_at = now()
where i.accepted_at is null and i.declined_at is null and i.revoked_at is null
  and exists (
    select 1 from public.trip_invites j
    where j.trip_id = i.trip_id and lower(j.email) = lower(i.email)
      and j.accepted_at is null and j.declined_at is null and j.revoked_at is null
      and (j.created_at > i.created_at or (j.created_at = i.created_at and j.id > i.id))
  );
-- Höchstens eine offene Einladung je Reise und Adresse
create unique index if not exists trip_invites_one_open
  on public.trip_invites (trip_id, lower(email))
  where accepted_at is null and declined_at is null and revoked_at is null;

-- Wer hat zuletzt geändert (für «Sabine hat das inzwischen geändert»)
alter table public.trips       add column if not exists updated_by uuid default auth.uid() references auth.users(id) on delete set null;
alter table public.waypoints   add column if not exists updated_by uuid default auth.uid() references auth.users(id) on delete set null;
alter table public.notes       add column if not exists updated_by uuid default auth.uid() references auth.users(id) on delete set null;
alter table public.media       add column if not exists updated_by uuid default auth.uid() references auth.users(id) on delete set null;
alter table public.trip_recaps add column if not exists updated_by uuid default auth.uid() references auth.users(id) on delete set null;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2 · Hilfsfunktionen und Trigger
-- ─────────────────────────────────────────────────────────────────────────────

-- Feste Farben für Domi/Sabine/Anna (nach Anzeigename), sonst Palette nach Konto-ID.
create or replace function private.pick_avatar_color(p_name text, p_id uuid)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when lower(coalesce(p_name, '')) ~ '^dom'    then '#0066b3'
    when lower(coalesce(p_name, '')) ~ '^sabine' then '#D64541'
    when lower(coalesce(p_name, '')) ~ '^anna'   then '#1F9D57'
    else (array['#C25E00','#7B4FB8','#00838F','#B83280','#5D6D7E','#8D6E00','#3F51B5','#A0522D'])
         [1 + (abs(hashtext(coalesce(p_id::text, ''))) % 8)]
  end;
$$;

-- Setzt die Farbe automatisch. Eine selbst gewählte Farbe bleibt; eine automatisch
-- gesetzte folgt einer Namensänderung (z. B. «sabine.roeder» → «Sabine»).
create or replace function private.profiles_avatar_color()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.avatar_color is null then
    new.avatar_color := private.pick_avatar_color(new.display_name, new.id);
  elsif tg_op = 'UPDATE'
        and new.display_name is distinct from old.display_name
        and new.avatar_color = old.avatar_color
        and old.avatar_color = private.pick_avatar_color(old.display_name, old.id) then
    new.avatar_color := private.pick_avatar_color(new.display_name, new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_avatar_color on public.profiles;
create trigger profiles_avatar_color before insert or update on public.profiles
  for each row execute function private.profiles_avatar_color();

update public.profiles set avatar_color = private.pick_avatar_color(display_name, id)
where avatar_color is null;

-- updated_by = wer gerade schreibt (bei Service-Zugriffen ohne Login bleibt der alte Wert)
create or replace function private.touch_updated_by()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_by := coalesce((select auth.uid()), new.updated_by);
  return new;
end;
$$;

drop trigger if exists trips_touch_by on public.trips;
create trigger trips_touch_by before insert or update on public.trips
  for each row execute function private.touch_updated_by();
drop trigger if exists waypoints_touch_by on public.waypoints;
create trigger waypoints_touch_by before insert or update on public.waypoints
  for each row execute function private.touch_updated_by();
drop trigger if exists notes_touch_by on public.notes;
create trigger notes_touch_by before insert or update on public.notes
  for each row execute function private.touch_updated_by();
drop trigger if exists media_touch_by on public.media;
create trigger media_touch_by before insert or update on public.media
  for each row execute function private.touch_updated_by();
drop trigger if exists trip_recaps_touch_by on public.trip_recaps;
create trigger trip_recaps_touch_by before insert or update on public.trip_recaps
  for each row execute function private.touch_updated_by();

-- Beitragender darf seinen eigenen Ort nicht (weich) löschen, solange dort Fotos
-- oder Notizen anderer Personen hängen. Sonst würden fremde Inhalte unsichtbar.
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

drop trigger if exists waypoints_guard_contributor_delete on public.waypoints;
create trigger waypoints_guard_contributor_delete before update on public.waypoints
  for each row execute function private.guard_contributor_place_delete();

-- ─────────────────────────────────────────────────────────────────────────────
-- 3 · RLS
-- ─────────────────────────────────────────────────────────────────────────────
-- Muster für waypoints/notes/media:
--   SELECT  alle Mitglieder (unverändert)
--   INSERT  eigene Zeile (created_by = ich) für owner, editor UND viewer (neu: viewer)
--   UPDATE  owner/editor alles; viewer nur eigene Zeilen (created_by = ich)
--   DELETE  wie UPDATE (die App löscht weich per UPDATE deleted_at, DELETE ist Reserve)
-- trips, trip_recaps: unverändert (viewer weiterhin nur lesen, Recaps nur final).

-- waypoints
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

-- notes
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

-- media
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

-- storage.objects (Buckets media-originals, media-thumbs; Pfad beginnt mit trip_id/)
-- Beitragender lädt hoch; ändern/löschen nur Dateien, die er selbst hochgeladen hat (owner_id).
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

-- trip_members: Lesen für Mitglieder (unverändert). Austreten (eigene Zeile) und Entfernen
-- durch den Besitzer bleiben als DELETE erlaubt. Hinzufügen und Rolle ändern nur noch über
-- die RPCs (accept_trip_invite*, set_trip_access_role); der Besitzer-Eintrag beim Anlegen
-- einer Reise kommt weiter vom Trigger private.add_trip_owner (SECURITY DEFINER).
drop policy if exists trip_members_insert on public.trip_members;
drop policy if exists trip_members_update on public.trip_members;

-- trip_invites: Lesen für Besitzer und die eingeladene Adresse (unverändert).
-- Anlegen/Ändern nur noch über RPCs, damit «nur registrierte Adressen» nicht umgangen wird.
drop policy if exists trip_invites_insert on public.trip_invites;
drop policy if exists trip_invites_update on public.trip_invites;
drop policy if exists trip_invites_select on public.trip_invites;
create policy trip_invites_select on public.trip_invites for select to authenticated
  using (
    (select private.has_trip_role(trip_id, array['owner']))
    or invited_user_id = (select auth.uid())
    or lower(email) = lower(((select auth.jwt()) ->> 'email'))
  );
-- trip_invites_delete (nur Besitzer) bleibt unverändert.

-- ─────────────────────────────────────────────────────────────────────────────
-- 4 · Presence («Sabine bearbeitet gerade»), ohne Sperre
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.trip_presence (
  trip_id  uuid not null references public.trips(id) on delete cascade,
  user_id  uuid not null references auth.users(id) on delete cascade,
  target   text not null default 'trip' check (char_length(target) between 1 and 80),
  seen_at  timestamptz not null default now(),
  primary key (trip_id, user_id)
);
alter table public.trip_presence enable row level security;
-- Keine Policies: direkter Zugriff gesperrt, nur über die RPCs in Abschnitt 5.
revoke all on table public.trip_presence from anon, authenticated;

-- Zähler für Adressprüfungen (gegen Ausprobieren, ob es ein Konto gibt)
create table if not exists private.invite_lookups (
  user_id uuid not null,
  at      timestamptz not null default now()
);
create index if not exists invite_lookups_user_at_idx on private.invite_lookups (user_id, at);
alter table private.invite_lookups enable row level security;
revoke all on table private.invite_lookups from anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5 · RPCs (alle SECURITY DEFINER, search_path leer, alle Namen voll qualifiziert)
-- ─────────────────────────────────────────────────────────────────────────────

-- 5.1 Einladen. p_invites = [{"email":"anna@web.de","role":"viewer"}, …] (role editor|viewer)
-- Ergebnis je Adresse: invited | updated (offene Einladung, Rolle/Frist erneuert) |
-- already_member | not_registered | self | invalid | rate_limited
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

-- 5.2 Meine offenen Einladungen (Einladungskarte in der Reiseübersicht).
-- Liefert Reise-Kopf, Einladenden und «Schon dabei» – Dinge, die die eingeladene Person
-- per RLS noch nicht lesen darf.
create or replace function public.list_my_trip_invites()
returns table (
  invite_id uuid, trip_id uuid, trip_title text, start_date date, end_date date,
  cover_preset text, role text, invited_by uuid, inviter_name text, inviter_color text,
  inviter_role text, members jsonb, created_at timestamptz, expires_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select i.id, t.id, t.title, t.start_date, t.end_date, t.cover_preset, i.role,
         i.created_by, p.display_name, p.avatar_color, im.role,
         coalesce((
           select jsonb_agg(jsonb_build_object(
                    'user_id', m.user_id, 'display_name', mp.display_name,
                    'avatar_color', mp.avatar_color, 'role', m.role)
                  order by (m.role = 'owner') desc, m.created_at)
           from public.trip_members m
           left join public.profiles mp on mp.id = m.user_id
           where m.trip_id = t.id), '[]'::jsonb),
         i.created_at, i.expires_at
  from public.trip_invites i
  join public.trips t on t.id = i.trip_id
  left join public.profiles p on p.id = i.created_by
  left join public.trip_members im on im.trip_id = i.trip_id and im.user_id = i.created_by
  where (select auth.uid()) is not null
    and (i.invited_user_id = (select auth.uid())
         or lower(i.email) = lower(coalesce(((select auth.jwt()) ->> 'email'), '')))
    and i.accepted_at is null and i.declined_at is null and i.revoked_at is null
    and i.expires_at > now()
    and not exists (select 1 from public.trip_members x
                    where x.trip_id = i.trip_id and x.user_id = (select auth.uid()))
  order by i.created_at desc;
$$;

-- 5.3 Beitreten über die Einladungs-ID (Karte «Beitreten»). Gibt die trip_id zurück.
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
  update public.trip_invites set accepted_at = now(), accepted_by = v_uid where id = v_inv.id;
  return v_inv.trip_id;
end;
$$;

-- 5.3b Bestehende Token-Variante: gleiche Prüfungen, zusätzlich abgelehnt/zurückgezogen.
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
  update public.trip_invites set accepted_at = now(), accepted_by = v_uid where id = v_inv.id;
  return v_inv.trip_id;
end;
$$;

-- 5.4 Ablehnen
create or replace function public.decline_trip_invite(p_invite_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := (select auth.uid());
  v_email text := lower(coalesce((select auth.jwt() ->> 'email'), ''));
  v_n     integer;
begin
  if v_uid is null then raise exception 'Nicht angemeldet' using errcode = '28000'; end if;
  update public.trip_invites i set declined_at = now()
   where i.id = p_invite_id
     and (i.invited_user_id = v_uid or lower(i.email) = v_email)
     and i.accepted_at is null and i.declined_at is null and i.revoked_at is null;
  get diagnostics v_n = row_count;
  if v_n = 0 then raise exception 'Einladung nicht gefunden' using errcode = 'P0002'; end if;
end;
$$;

-- 5.5 Rolle ändern (Mitglied oder offene Einladung), nur Besitzer, nur editor|viewer.
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

-- 5.6 Zugriff entziehen: Mitglied entfernen oder offene Einladung zurückziehen.
-- Inhalte der Person bleiben in der Reise (keine Löschung von waypoints/notes/media).
create or replace function public.revoke_trip_access(
  p_trip_id uuid, p_user_id uuid default null, p_invite_id uuid default null)
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
  if (p_user_id is null) = (p_invite_id is null) then
    raise exception 'Genau eine Person oder Einladung angeben' using errcode = '22023';
  end if;
  if p_user_id is not null then
    if p_user_id = v_uid then raise exception 'Als Besitzer nicht entfernbar' using errcode = '42501'; end if;
    delete from public.trip_members m
     where m.trip_id = p_trip_id and m.user_id = p_user_id and m.role <> 'owner';
    get diagnostics v_n = row_count;
    delete from public.trip_presence pr where pr.trip_id = p_trip_id and pr.user_id = p_user_id;
    -- offene Einladungen derselben Person gleich mit zurückziehen
    update public.trip_invites i set revoked_at = now()
     where i.trip_id = p_trip_id and i.invited_user_id = p_user_id
       and i.accepted_at is null and i.declined_at is null and i.revoked_at is null;
  else
    update public.trip_invites i set revoked_at = now()
     where i.id = p_invite_id and i.trip_id = p_trip_id
       and i.accepted_at is null and i.declined_at is null and i.revoked_at is null;
    get diagnostics v_n = row_count;
  end if;
  if v_n = 0 then raise exception 'Nicht gefunden' using errcode = 'P0002'; end if;
end;
$$;

-- 5.7 Reise verlassen (Mitbearbeiter/Beitragender). Inhalte bleiben in der Reise.
create or replace function public.leave_trip(p_trip_id uuid)
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
  if private.has_trip_role(p_trip_id, array['owner']) then
    raise exception 'Als Besitzer kannst du die Reise nicht verlassen' using errcode = '42501';
  end if;
  delete from public.trip_members m where m.trip_id = p_trip_id and m.user_id = v_uid;
  get diagnostics v_n = row_count;
  if v_n = 0 then raise exception 'Nicht gefunden' using errcode = 'P0002'; end if;
  delete from public.trip_presence pr where pr.trip_id = p_trip_id and pr.user_id = v_uid;
end;
$$;

-- 5.8 Personen der Reise: Mitglieder (alle sehen Name, Farbe, Rolle), offene Einladungen
-- (nur der Besitzer, mit Adresse) und ehemalige Autoren (Name an alten Fotos/Notizen).
-- person_kind: member | invite | former; status: aktiv | eingeladen | abgelaufen | ehemalig
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
  select 'member'::text, m.user_id, null::uuid, p.display_name, p.avatar_color,
         m.role, 'aktiv'::text,
         case when v_owner then (select u.email::text from auth.users u where u.id = m.user_id) end,
         m.created_at, null::timestamptz
  from public.trip_members m
  left join public.profiles p on p.id = m.user_id
  where m.trip_id = p_trip_id;

  if v_owner then
    return query
    select 'invite'::text, i.invited_user_id, i.id, p.display_name, p.avatar_color,
           i.role, case when i.expires_at > now() then 'eingeladen' else 'abgelaufen' end,
           i.email, i.created_at, i.expires_at
    from public.trip_invites i
    left join public.profiles p on p.id = i.invited_user_id
    where i.trip_id = p_trip_id
      and i.accepted_at is null and i.declined_at is null and i.revoked_at is null;
  end if;

  return query
  select 'former'::text, a.uid, null::uuid, p.display_name, p.avatar_color,
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

-- 5.9 Presence: melden (alle ~30 s solange ein Bearbeiten-Sheet offen ist), abmelden, lesen.
-- target z. B. 'trip', 'place:<uuid>', 'note:<uuid>', 'diary', 'recap'.
create or replace function public.touch_trip_presence(p_trip_id uuid, p_target text default 'trip')
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null or not private.is_trip_member(p_trip_id) then
    raise exception 'Kein Zugriff' using errcode = '42501';
  end if;
  insert into public.trip_presence (trip_id, user_id, target, seen_at)
  values (p_trip_id, v_uid, left(coalesce(nullif(p_target, ''), 'trip'), 80), now())
  on conflict (trip_id, user_id) do update set target = excluded.target, seen_at = now();
  delete from public.trip_presence pr where pr.seen_at < now() - interval '1 day';
end;
$$;

create or replace function public.clear_trip_presence(p_trip_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.trip_presence pr
  where pr.trip_id = p_trip_id and pr.user_id = (select auth.uid());
$$;

create or replace function public.list_trip_presence(p_trip_id uuid, p_window_s integer default 90)
returns table (user_id uuid, display_name text, avatar_color text, target text, seen_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select pr.user_id, p.display_name, p.avatar_color, pr.target, pr.seen_at
  from public.trip_presence pr
  left join public.profiles p on p.id = pr.user_id
  where pr.trip_id = p_trip_id
    and private.is_trip_member(p_trip_id)
    and pr.user_id <> (select auth.uid())
    and pr.seen_at > now() - make_interval(secs => greatest(15, least(coalesce(p_window_s, 90), 600)))
    and exists (select 1 from public.trip_members m where m.trip_id = pr.trip_id and m.user_id = pr.user_id);
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6 · Rechte. Supabase gibt neuen Funktionen standardmäßig EXECUTE an PUBLIC/anon:
-- hier ausdrücklich nur authenticated.
-- ─────────────────────────────────────────────────────────────────────────────
revoke all on function public.invite_to_trip(uuid, jsonb)                   from public, anon;
revoke all on function public.list_my_trip_invites()                        from public, anon;
revoke all on function public.accept_trip_invite_by_id(uuid)                from public, anon;
revoke all on function public.accept_trip_invite(text)                      from public, anon;
revoke all on function public.decline_trip_invite(uuid)                     from public, anon;
revoke all on function public.set_trip_access_role(uuid, text, uuid, uuid)  from public, anon;
revoke all on function public.revoke_trip_access(uuid, uuid, uuid)          from public, anon;
revoke all on function public.leave_trip(uuid)                              from public, anon;
revoke all on function public.list_trip_people(uuid)                        from public, anon;
revoke all on function public.touch_trip_presence(uuid, text)               from public, anon;
revoke all on function public.clear_trip_presence(uuid)                     from public, anon;
revoke all on function public.list_trip_presence(uuid, integer)             from public, anon;

grant execute on function public.invite_to_trip(uuid, jsonb)                  to authenticated;
grant execute on function public.list_my_trip_invites()                       to authenticated;
grant execute on function public.accept_trip_invite_by_id(uuid)               to authenticated;
grant execute on function public.accept_trip_invite(text)                     to authenticated;
grant execute on function public.decline_trip_invite(uuid)                    to authenticated;
grant execute on function public.set_trip_access_role(uuid, text, uuid, uuid) to authenticated;
grant execute on function public.revoke_trip_access(uuid, uuid, uuid)         to authenticated;
grant execute on function public.leave_trip(uuid)                             to authenticated;
grant execute on function public.list_trip_people(uuid)                       to authenticated;
grant execute on function public.touch_trip_presence(uuid, text)              to authenticated;
grant execute on function public.clear_trip_presence(uuid)                    to authenticated;
grant execute on function public.list_trip_presence(uuid, integer)            to authenticated;

-- private-Helfer: nur Trigger/RPCs nutzen sie, keine Aufrufe von außen
revoke all on function private.guard_contributor_place_delete()    from public, anon;

commit;

-- ─────────────────────────────────────────────────────────────────────────────
-- Prüfabfragen nach dem Lauf (einzeln ausführen, nur lesen):
-- select tablename, policyname, cmd from pg_policies
--   where schemaname in ('public','storage') order by 1,3,2;
-- select proname, prosecdef, proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' order by 1;
-- select routine_name, grantee from information_schema.routine_privileges
--   where routine_schema = 'public' and grantee in ('anon','authenticated','PUBLIC') order by 1,2;
-- select column_name from information_schema.columns
--   where table_schema = 'public' and column_name in ('updated_by','avatar_color','invited_user_id','declined_at','revoked_at');
-- ─────────────────────────────────────────────────────────────────────────────

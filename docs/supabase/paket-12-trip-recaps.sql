-- Dokumentation. Die Tabelle ist in Supabase bereits angelegt. Nicht erneut ausführen.
-- Paket 12 · Version mit Dominiks Entscheidungen vom 30.10.2026 (DB-Go t803u):
-- mehrere Entwürfe je Reise, Notizen getrennt von Entwürfen, Papierkorb (deleted_at), Basis-Entwurf (based_on).
-- Paket 12 (Pilot Recap): eine neue Tabelle für Entwürfe und finale Fassungen
-- von Reisetagebuch (kind = 'diary') und Recap-Video (kind = 'video').
-- Muster wie bei trips/notes: RLS mit private.is_trip_member / private.has_trip_role,
-- Trigger private.keep_created_by + private.touch_updated_at (gibt es schon).
-- Stand Schema geprüft: 30.10.2026 (nur gelesen).

create table public.trip_recaps (
  id            uuid primary key default gen_random_uuid(),
  trip_id       uuid not null references public.trips(id) on delete cascade,
  kind          text not null check (kind in ('video', 'diary')),
  status        text not null default 'draft' check (status in ('notes', 'draft', 'final')),
  version       integer not null default 1 check (version >= 1),
  source_text   text check (source_text is null or char_length(source_text) <= 30000),  -- eingefügter Gesamtbericht (nur diary)
  content       jsonb not null default '{}'::jsonb,                                        -- Entwurf/Fassung, Aufbau siehe SPEC-PILOT.md
  feedback      jsonb not null default '[]'::jsonb check (jsonb_typeof(feedback) = 'array'), -- [{at, by, version, text, status}]
  created_by    uuid not null default auth.uid() references auth.users(id) on delete restrict,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  finalized_at  timestamptz,
  deleted_at    timestamptz,                                                                -- Papierkorb: 7 Tage wiederherstellbar
  based_on      uuid references public.trip_recaps(id) on delete set null                   -- neuer Entwurf basiert auf diesem
);

-- status 'notes' = gesammelte Notizen (nur diary), bleiben beim Löschen von Entwürfen erhalten.
-- Höchstens eine Notizzeile und eine finale Fassung je Reise und Art; Entwürfe beliebig viele.
create unique index trip_recaps_one_notes on public.trip_recaps (trip_id, kind) where status = 'notes';
create unique index trip_recaps_one_final on public.trip_recaps (trip_id, kind) where status = 'final';

create index trip_recaps_trip_idx on public.trip_recaps (trip_id);

create trigger trip_recaps_keep_author before update on public.trip_recaps
  for each row execute function private.keep_created_by();
create trigger trip_recaps_touch before update on public.trip_recaps
  for each row execute function private.touch_updated_at();

alter table public.trip_recaps enable row level security;

-- Lesen: Owner/Editor sehen alles. Andere Mitglieder (Gäste/Viewer) nur die finale Fassung.
create policy trip_recaps_select on public.trip_recaps for select to authenticated
  using (
    (select private.has_trip_role(trip_id, array['owner', 'editor']))
    or (status = 'final' and (select private.is_trip_member(trip_id)))
  );

-- Anlegen: nur Owner/Editor, Autor = ich.
create policy trip_recaps_insert on public.trip_recaps for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and (select private.has_trip_role(trip_id, array['owner', 'editor']))
  );

-- Ändern (Feedback, Text, Übernehmen): nur Owner/Editor.
create policy trip_recaps_update on public.trip_recaps for update to authenticated
  using ((select private.has_trip_role(trip_id, array['owner', 'editor'])))
  with check ((select private.has_trip_role(trip_id, array['owner', 'editor'])));

-- Verwerfen (Entwurf löschen) bzw. alte finale Fassung ersetzen: nur Owner/Editor.
create policy trip_recaps_delete on public.trip_recaps for delete to authenticated
  using ((select private.has_trip_role(trip_id, array['owner', 'editor'])));

-- Rückweg (falls nötig):
-- drop table if exists public.trip_recaps;

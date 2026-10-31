-- Paket 2: Pro Reise angeben, wer dabei ist.
-- Diese Datei wurde NICHT ausgeführt. Einmal im Supabase-SQL-Editor ausführen.
-- Solange die Spalte fehlt, speichert die App die übrige Reise trotzdem
-- und zeigt «Wer ist dabei noch nicht verfügbar».
-- Mehrfach ausführbar.

alter table public.trips add column if not exists companion_tags text[] not null default '{}';

alter table public.trips
  drop constraint if exists trips_companion_tags_check;

alter table public.trips
  add constraint trips_companion_tags_check
  check (
    companion_tags <@ array['allein', 'partner', 'familie', 'freunde']::text[]
  );

notify pgrst, 'reload schema';

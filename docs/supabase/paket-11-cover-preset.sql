-- Paket 11: Motiv der Reise dauerhaft speichern (Stadt, Strand, Berge, …).
-- Diese Datei wurde NICHT ausgeführt. Einmal im Supabase-SQL-Editor ausführen.
-- Solange die Spalte fehlt, speichert die App die Reise ohne cover_preset
-- und die Motiv-Wahl steht nach dem Neuladen wieder auf «Stadt».
-- Titelbild-Fotos brauchen das nicht: cover_media_id gibt es schon.

alter table public.trips
  add column if not exists cover_preset text;

alter table public.trips
  drop constraint if exists trips_cover_preset_check;

alter table public.trips
  add constraint trips_cover_preset_check
  check (
    cover_preset is null
    or cover_preset = any (array['stadt', 'strand', 'berge', 'wald', 'roadtrip', 'winter'])
  );

notify pgrst, 'reload schema';

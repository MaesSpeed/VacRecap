-- Paket 9b: Genau eine Bildunterschrift pro Foto (nullable).
-- Diese Datei wurde NICHT ausgeführt. Einmal im Supabase-SQL-Editor ausführen.
-- Solange die Spalte fehlt, lässt die App Fotos unangetastet und zeigt
-- «Fotonotiz noch nicht verfügbar». Bestehende RLS-Policies auf media
-- bleiben unverändert (Owner/Editor dürfen updaten, wie bisher).

alter table public.media
  add column if not exists caption text;

alter table public.media
  drop constraint if exists media_caption_check;

alter table public.media
  add constraint media_caption_check
  check (caption is null or char_length(caption) <= 500);

notify pgrst, 'reload schema';

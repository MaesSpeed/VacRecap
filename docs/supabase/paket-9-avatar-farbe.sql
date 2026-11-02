-- Nur nach DB-Go. Nicht ausführen, bis Dominik das explizit freigibt.
-- Paket 9: Auto-Farbe auch für Namen wie roeder.domi (Dom/Sabine/Anna hinter einem Trenner).
-- iammrspeed passt auf kein Muster. Dafür ist die selbst gewählte Farbe (U10, nicht in diesem Paket) der Weg.
-- Idempotent: create or replace, Update nur wo die gespeicherte Farbe noch die alte Auto-Farbe ist.

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
    when lower(coalesce(p_name, '')) ~ '(^|[._ -])dom'    then '#0066b3'
    when lower(coalesce(p_name, '')) ~ '(^|[._ -])sabine' then '#D64541'
    when lower(coalesce(p_name, '')) ~ '(^|[._ -])anna'   then '#1F9D57'
    else (array['#C25E00','#7B4FB8','#00838F','#B83280','#5D6D7E','#8D6E00','#3F51B5','#A0522D'])
         [1 + (abs(hashtext(coalesce(p_id::text, ''))) % 8)]
  end;
$$;

-- Zählen, bevor das Update läuft (nur lesen):
-- select count(*) from public.profiles p
--  where p.avatar_color is distinct from private.pick_avatar_color(p.display_name, p.id)
--    and p.avatar_color = case
--      when lower(coalesce(p.display_name, '')) ~ '^dom' then '#0066b3'
--      when lower(coalesce(p.display_name, '')) ~ '^sabine' then '#D64541'
--      when lower(coalesce(p.display_name, '')) ~ '^anna' then '#1F9D57'
--      else (array['#C25E00','#7B4FB8','#00838F','#B83280','#5D6D7E','#8D6E00','#3F51B5','#A0522D'])
--           [1 + (abs(hashtext(coalesce(p.id::text, ''))) % 8)]
--    end;

-- Nur Auto-Farben: die gespeicherte Farbe ist noch das Ergebnis der bisherigen
-- Zuordnung (Namensanfang bzw. Palette nach Konto-ID). Eine selbst gewählte Farbe bleibt.
update public.profiles p
set avatar_color = private.pick_avatar_color(p.display_name, p.id)
where p.avatar_color is distinct from private.pick_avatar_color(p.display_name, p.id)
  and p.avatar_color = case
    when lower(coalesce(p.display_name, '')) ~ '^dom' then '#0066b3'
    when lower(coalesce(p.display_name, '')) ~ '^sabine' then '#D64541'
    when lower(coalesce(p.display_name, '')) ~ '^anna' then '#1F9D57'
    else (array['#C25E00','#7B4FB8','#00838F','#B83280','#5D6D7E','#8D6E00','#3F51B5','#A0522D'])
         [1 + (abs(hashtext(coalesce(p.id::text, ''))) % 8)]
  end;

// Dauerformel Recap-Video, Paket 12b. ALLE WERTE SIND STARTWERTE ZUM NACHJUSTIEREN.
export const P = {
  introS: 3,
  outroS: 3,
  perPlaceS: 1.5,
  photosPerPlace: 3,
  perPhotoS: 1.5,
  perNoteS: 1.5,
  maxNotesPerPlace: 2,
  minS: 30,
  // Früherer Deckel. Wird nicht mehr angewendet: die Dauer darf darüber wachsen.
  maxS: 150,
  maxPhotoS: 2.5,
  minPhotos: 6,
  dayMapS: 3,
};

// places: [{ photos: n, notes: n }]
export function plan(places, p = P) {
  const totalPhotos = places.reduce((a, x) => a + x.photos, 0);
  if (totalPhotos < p.minPhotos) return { ok: false, reason: "too-few-photos", totalPhotos };
  const calc = (perPlace, photoS) => {
    let used = 0;
    let notes = 0;
    for (const x of places) {
      used += Math.min(x.photos, perPlace);
      notes += Math.min(x.notes, p.maxNotesPerPlace);
    }
    const s = p.introS + p.outroS + places.length * p.perPlaceS + used * photoS + notes * p.perNoteS;
    return { s, used, notes, perPlace, photoS };
  };
  let r = calc(p.photosPerPlace, p.perPhotoS);
  while (r.s < p.minS && r.used < totalPhotos) r = calc(r.perPlace + 1, p.perPhotoS);
  if (r.s < p.minS) {
    const extra = (p.minS - r.s) / r.used;
    r = calc(r.perPlace, Math.min(p.maxPhotoS, p.perPhotoS + extra));
  }
  const seconds = Math.max(p.minS, r.s);
  return {
    ok: true,
    seconds,
    rawSeconds: r.s,
    photosUsed: r.used,
    notesUsed: r.notes,
    photosPerPlace: r.perPlace,
    perPhotoS: r.photoS,
    label: fmt(seconds),
  };
}

export const fmt = (s) => {
  const r = Math.round(s / 5) * 5;
  return `ca. ${Math.floor(r / 60)}:${String(r % 60).padStart(2, "0")} min`;
};

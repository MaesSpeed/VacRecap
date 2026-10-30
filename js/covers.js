import { assetUrl } from "./config.js";

/** Preset-Titelbilder (lokal, JPEG aus Wikimedia Commons). */
export const COVER_PRESETS = [
  {
    id: "stadt",
    label: "Stadt",
    file: "assets/covers/stadt.jpg",
    thumb: "assets/covers/stadt-thumb.jpg",
  },
  {
    id: "strand",
    label: "Strand",
    file: "assets/covers/strand.jpg",
    thumb: "assets/covers/strand-thumb.jpg",
  },
  {
    id: "berge",
    label: "Berge",
    file: "assets/covers/berge.jpg",
    thumb: "assets/covers/berge-thumb.jpg",
  },
  {
    id: "wald",
    label: "Wald",
    file: "assets/covers/wald.jpg",
    thumb: "assets/covers/wald-thumb.jpg",
  },
  {
    id: "roadtrip",
    label: "Roadtrip",
    file: "assets/covers/roadtrip.jpg",
    thumb: "assets/covers/roadtrip-thumb.jpg",
  },
  {
    id: "winter",
    label: "Winter",
    file: "assets/covers/winter.jpg",
    thumb: "assets/covers/winter-thumb.jpg",
  },
];

export const COVER_CREDITS = [
  {
    presetId: "stadt",
    title: "Eiffel Tower and Pont Alexandre III at night",
    author: "Getfunky Paris",
    license: "CC BY 2.0",
    licenseUrl: "https://creativecommons.org/licenses/by/2.0/",
    file: "Eiffel Tower and Pont Alexandre III at night.jpg",
  },
  {
    presetId: "strand",
    title: "Havelock Island, Sandy lagoon, Andaman Islands",
    author: "Vyacheslav Argenberg",
    license: "CC BY 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    file: "Havelock Island, Sandy lagoon, Andaman Islands.jpg",
  },
  {
    presetId: "berge",
    title: "Panixersee (Lag da Pigniu) boven Andiast",
    author: "Dominicus Johannes Bergsma",
    license: "CC BY-SA 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
    file: "Panixersee (Lag da Pigniu) boven Andiast. 26-09-2025. (d.j.b.) 14.jpg",
  },
  {
    presetId: "wald",
    title: "Dülmen, Wildpark",
    author: "Dietmar Rabich",
    license: "CC BY-SA 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
    file: "Dülmen, Wildpark -- 2015 -- 8871-7.jpg",
  },
  {
    presetId: "roadtrip",
    title: "Amboy (California), Historic Route 66",
    author: "Dietmar Rabich",
    license: "CC BY-SA 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
    file: "Amboy (California, USA), Hist. Route 66 -- 2012 -- 5705.jpg",
  },
  {
    presetId: "winter",
    title: "Snow Scene at Shipka Pass",
    author: "Psy guy",
    license: "CC BY-SA 3.0",
    licenseUrl: "https://creativecommons.org/licenses/by-sa/3.0/",
    file: "Snow Scene at Shipka Pass 1.JPG",
  },
];

export function normalizePresetId(id) {
  return COVER_PRESETS.some((p) => p.id === id) ? id : "stadt";
}

export function presetById(id) {
  return COVER_PRESETS.find((p) => p.id === id) ?? COVER_PRESETS[0];
}

export function presetUrl(presetId) {
  return assetUrl(presetById(presetId).file);
}

export function presetThumbUrl(presetId) {
  return assetUrl(presetById(presetId).thumb);
}

export async function resolveCoverSrc(vacation, getBlobFn) {
  const presetId = normalizePresetId(vacation?.cover?.presetId);
  if (!vacation?.cover || vacation.cover.type === "preset") return presetUrl(presetId);
  if (vacation.cover.type === "custom" && vacation.cover.blobId) {
    const record = await getBlobFn(vacation.cover.blobId);
    if (record?.data) return URL.createObjectURL(record.data);
  }
  return presetUrl(presetId);
}

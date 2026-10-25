import { assetUrl } from "./config.js";

/** Preset-Titelbilder (lokal, SVG). */
export const COVER_PRESETS = [
  { id: "stadt", label: "Stadt", file: "assets/covers/stadt.svg" },
  { id: "strand", label: "Strand", file: "assets/covers/strand.svg" },
  { id: "berge", label: "Berge", file: "assets/covers/berge.svg" },
  { id: "wald", label: "Wald", file: "assets/covers/wald.svg" },
  { id: "roadtrip", label: "Roadtrip", file: "assets/covers/roadtrip.svg" },
  { id: "winter", label: "Winter", file: "assets/covers/winter.svg" },
];

export function presetById(id) {
  return COVER_PRESETS.find((p) => p.id === id) ?? COVER_PRESETS[0];
}

export function presetUrl(presetId) {
  return assetUrl(presetById(presetId).file);
}

export async function resolveCoverSrc(vacation, getBlobFn) {
  if (!vacation?.cover) return presetUrl("stadt");
  if (vacation.cover.type === "preset") {
    return presetUrl(vacation.cover.presetId || "stadt");
  }
  if (vacation.cover.type === "custom" && vacation.cover.blobId) {
    const record = await getBlobFn(vacation.cover.blobId);
    if (record?.data) {
      return URL.createObjectURL(record.data);
    }
  }
  return presetUrl("stadt");
}

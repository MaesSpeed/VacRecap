import { photoKeptMessage } from "./cloud-errors.js";
import { defaultActiveDay } from "./days.js";
import { getPlacesForDay, putPlace } from "./db.js";
import { createPlace } from "./places.js";
import { readPhotoExif } from "./exif-taken-at.js";
import { reverseGeocodeName } from "./geo.js";
import { planPhotoGroups, resolveCaptureDay } from "./photo-assign.js";
import { createCapturePlace, getOrCreateOhneOrtPlace, resolveGalleryPhotoTarget } from "./target-place.js";
import { getSamePlaceRadiusM } from "./settings-store.js";
import { saveTripSelection, loadTripSelection } from "./trip-selection-store.js";
import { showToast, showWarnToast } from "./toast.js";
import { openPhotoAssignSheet } from "./ui-photo-assign-sheet.js";
import { openPhotoUploadSheet } from "./ui-photo-upload-sheet.js";
import { clampTitle } from "./utils.js";

const VIDEO_NAME = /\.(mov|mp4|m4v|webm|hevc)$/i;

export function splitGalleryFiles(files) {
  const all = [...(files || [])];
  const hasVideo = all.some(
    (file) => file.type?.startsWith("video/") || VIDEO_NAME.test(file.name || "")
  );
  const images = all.filter((file) => file.type?.startsWith("image/"));
  return { hasVideo, images };
}

async function placesForDays(vacationId, days) {
  const lists = await Promise.all([...days].map((day) => getPlacesForDay(vacationId, day)));
  return lists.flat();
}

async function nameNewGroups(groups) {
  const pending = [];
  await Promise.all(
    groups
      .filter((group) => group.kind === "new" && group.lat != null)
      .map(async (group) => {
        const job = reverseGeocodeName(group.lat, group.lng)
          .then((name) => (name ? clampTitle(name) : null))
          .catch(() => null);
        const quick = await Promise.race([
          job,
          new Promise((resolve) => setTimeout(() => resolve(null), 900)),
        ]);
        if (quick) {
          group.name = quick;
          if (group.suggested) group.suggested.name = quick;
        } else {
          pending.push(
            job.then((late) => {
              if (!late) return null;
              group.name = late;
              if (group.suggested) group.suggested.name = late;
              return { id: group.id, name: late };
            })
          );
        }
      })
  );
  return pending;
}

async function materializeGroups(groups, vacationId) {
  const freshIds = [];
  let createdOhne = false;
  for (const group of groups) {
    if (group.kind === "place" && group.place) continue;
    if (group.kind === "new") {
      const named = group.name && !group.name.startsWith("Ort ");
      if (named) {
        group.place = await putPlace(
          createPlace({
            vacationId,
            day: group.day,
            ts: group.ts || Date.now(),
            lat: group.lat,
            lng: group.lng,
            name: group.name,
            soft: false,
            source: "capture",
          })
        );
      } else {
        const created = await createCapturePlace({
          vacationId,
          day: group.day,
          lat: group.lat,
          lng: group.lng,
          ts: group.ts || Date.now(),
        });
        group.place = created.place;
        group.name = created.place.name;
      }
      freshIds.push(group.place.id);
      continue;
    }
    const created = await getOrCreateOhneOrtPlace({
      vacationId,
      day: group.day,
      showToastOnCreate: false,
    });
    group.place = created.place;
    group.kind = "place";
    if (created.created) createdOhne = true;
  }
  return { freshIds, createdOhne };
}

function rememberSelection(vacationId, day, placeId) {
  return loadTripSelection(vacationId).then((saved) => {
    const next = saved || { selectedByDay: {}, activeDay: day };
    next.activeDay = day;
    next.selectedByDay = { ...(next.selectedByDay || {}), [day]: placeId };
    return saveTripSelection(vacationId, next);
  });
}

/**
 * Galerie: EXIF-GPS und Aufnahmetag. Sheet nur, wenn nicht alles auf der ausgewählten Karte liegt.
 */
export async function startGalleryPhotoUpload({
  vacation,
  vacationId,
  files,
  day,
  selectedPlaceId,
  onDone,
}) {
  const { hasVideo, images } = splitGalleryFiles(files);
  if (hasVideo) {
    showToast("Videos kommen in einem späteren Paket.", { icon: "none" });
  }
  if (!images.length) return null;
  const activeDay = day || (vacation ? defaultActiveDay(vacation) : null);
  if (!activeDay) {
    showWarnToast("Foto konnte nicht zugeordnet werden.");
    return null;
  }

  async function createTarget() {
    const target = await resolveGalleryPhotoTarget({
      vacationId,
      day: activeDay,
      selectedPlaceId,
    });
    await rememberSelection(vacationId, activeDay, target.place.id);
    return target;
  }

  async function openDirect(rows, target) {
    openPhotoUploadSheet({
      fileTargets: rows,
      place: target.place,
      vacationId,
      day: target.place.day || activeDay,
      onDone,
    });
    return {
      ...target,
      day: target.place.day || activeDay,
      needsRefresh: target.needsRefresh || target.createdOhneOrt,
      freshIds: [],
    };
  }

  try {
    const metas = await Promise.all(images.map((file) => readPhotoExif(file)));
    const photos = images.map((file, index) => {
      const meta = metas[index] || {};
      const takenAt = meta.takenAt ?? null;
      return {
        key: String(index),
        file,
        lat: meta.latitude ?? null,
        lng: meta.longitude ?? null,
        takenAt,
        day: resolveCaptureDay(takenAt, activeDay, vacation),
      };
    });
    const radiusM = await getSamePlaceRadiusM();
    const days = new Set(photos.map((photo) => photo.day));
    const places = await placesForDays(vacationId, days);
    const plan = planPhotoGroups({
      photos,
      places,
      activeDay,
      selectedPlaceId,
      radiusM,
      vacation,
    });

    if (!plan.needsSheet) {
      const target = await createTarget();
      const rows = photos.map((photo) => ({
        file: photo.file,
        place: target.place,
        day: activeDay,
      }));
      return openDirect(rows, target);
    }

    const selectedPlace = places.find((p) => p.id === selectedPlaceId && !p.soft) || null;
    const pendingNames = await nameNewGroups(plan.groups);
    const choice = await openPhotoAssignSheet({
      groups: plan.groups,
      filesByKey: new Map(photos.map((photo) => [photo.key, photo.file])),
      activeDay,
      vacation,
      selectedPlace,
      namesReady: Promise.all(pendingNames),
      dayPlaces: (dayIso) => places.filter((p) => !p.soft && (p.day || p.dayDate) === dayIso),
    });

    if (!choice || choice.type === "keep") {
      const target = selectedPlace
        ? { place: selectedPlace, createdOhneOrt: false, needsRefresh: false }
        : await createTarget();
      const rows = photos.map((photo) => ({ file: photo.file, place: target.place, day: activeDay }));
      if (target.place?.id) await rememberSelection(vacationId, activeDay, target.place.id);
      return openDirect(rows, target);
    }

    const { freshIds, createdOhne } = await materializeGroups(choice.groups, vacationId);
    const byKey = new Map(photos.map((photo) => [photo.key, photo]));
    const rows = [];
    for (const group of choice.groups) {
      for (const key of group.photoKeys) {
        const photo = byKey.get(key);
        if (!photo || !group.place) continue;
        rows.push({ file: photo.file, place: group.place, day: group.place.day || group.day });
      }
    }
    const primary =
      choice.groups.find((group) => group.place && freshIds.includes(group.place.id) && group.day === activeDay)?.place ||
      choice.groups.find((group) => group.place && group.day === activeDay)?.place ||
      choice.groups.find((group) => group.place)?.place ||
      selectedPlace;
    if (primary?.id) await rememberSelection(vacationId, primary.day || activeDay, primary.id);
    openPhotoUploadSheet({
      fileTargets: rows,
      place: primary,
      vacationId,
      day: primary?.day || activeDay,
      onDone,
    });
    return {
      place: primary,
      day: primary?.day || activeDay,
      createdOhneOrt: createdOhne,
      needsRefresh: true,
      freshIds,
    };
  } catch (err) {
    const message = photoKeptMessage(err);
    showWarnToast(message);
    openPhotoUploadSheet({
      files: images,
      place: null,
      vacationId,
      day: activeDay,
      heldMessage: message,
      ensurePlace: async () => (await createTarget()).place,
      onDone,
    });
    return null;
  }
}

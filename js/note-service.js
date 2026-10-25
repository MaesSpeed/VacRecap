import { deleteNote, putNote } from "./db.js";
import { createId } from "./utils.js";

export async function createNote({ place, vacationId, day, text }) {
  const record = {
    id: createId(),
    placeId: place.id,
    vacationId,
    day,
    ts: Date.now(),
    text: text.trim(),
  };
  await putNote(record);
  return record;
}

export async function updateNoteText(note, text) {
  const record = { ...note, text: text.trim(), ts: note.ts ?? Date.now() };
  await putNote(record);
  return record;
}

export async function moveNoteToPlace(note, place, { day, vacationId }) {
  const record = {
    ...note,
    placeId: place.id,
    day: day ?? note.day,
    vacationId: vacationId ?? note.vacationId,
    ts: note.ts ?? Date.now(),
  };
  await putNote(record);
  return record;
}

export async function removeNote(noteId) {
  await deleteNote(noteId);
}

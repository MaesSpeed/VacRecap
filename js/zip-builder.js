const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_DESCRIPTOR = 0x08074b50;
const FLAG_UTF8 = 0x0800;
const FLAG_DATA_DESCRIPTOR = 0x0008;

let crcTable = null;

function getCrcTable() {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    crcTable[i] = c >>> 0;
  }
  return crcTable;
}

export async function crc32Blob(blob) {
  const table = getCrcTable();
  let crc = 0xffffffff;
  const reader = blob.stream().getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (let i = 0; i < value.length; i++) {
      crc = table[(crc ^ value[i]) & 0xff] ^ (crc >>> 8);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(ts) {
  const d = new Date(ts);
  const year = Math.min(2107, Math.max(1980, d.getFullYear()));
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const hours = d.getHours();
  const minutes = d.getMinutes();
  const seconds = Math.floor(d.getSeconds() / 2);
  const date = ((year - 1980) << 9) | (month << 5) | day;
  const time = (hours << 11) | (minutes << 5) | seconds;
  return { date, time };
}

export class ZipWriter {
  constructor() {
    this.parts = [];
    this.offset = 0;
    this.entries = [];
  }

  get totalSize() {
    return this.entries.reduce((s, e) => s + e.size, 0);
  }

  async addFile(path, blob, { ts = Date.now() } = {}) {
    const nameBytes = new TextEncoder().encode(path.replace(/\\/g, "/"));
    const { date, time } = dosDateTime(ts);
    const localStart = this.offset;

    const header = new Uint8Array(30 + nameBytes.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, SIG_LOCAL, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, FLAG_UTF8 | FLAG_DATA_DESCRIPTOR, true);
    view.setUint16(8, 0, true);
    view.setUint16(10, time, true);
    view.setUint16(12, date, true);
    view.setUint32(26, nameBytes.length, true);
    view.setUint16(28, 0, true);
    header.set(nameBytes, 30);
    this.parts.push(header);
    this.offset += header.length;

    const crc = await crc32Blob(blob);
    const size = blob.size;
    this.parts.push(blob);
    this.offset += size;

    const desc = new Uint8Array(16);
    const dv = new DataView(desc.buffer);
    dv.setUint32(0, SIG_DESCRIPTOR, true);
    dv.setUint32(4, crc, true);
    dv.setUint32(8, size, true);
    dv.setUint32(12, size, true);
    this.parts.push(desc);
    this.offset += 16;

    this.entries.push({
      nameBytes,
      date,
      time,
      crc,
      size,
      localStart,
    });
  }

  async addTextFile(path, text, { ts = Date.now() } = {}) {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    await this.addFile(path, blob, { ts });
  }

  finalize() {
    const centralStart = this.offset;
    for (const e of this.entries) {
      const central = new Uint8Array(46 + e.nameBytes.length);
      const view = new DataView(central.buffer);
      view.setUint32(0, SIG_CENTRAL, true);
      view.setUint16(4, 20, true);
      view.setUint16(6, 20, true);
      view.setUint16(8, FLAG_UTF8 | FLAG_DATA_DESCRIPTOR, true);
      view.setUint16(10, 0, true);
      view.setUint16(12, e.time, true);
      view.setUint16(14, e.date, true);
      view.setUint32(16, e.crc, true);
      view.setUint32(20, e.size, true);
      view.setUint32(24, e.size, true);
      view.setUint16(28, e.nameBytes.length, true);
      view.setUint16(30, 0, true);
      view.setUint16(32, 0, true);
      view.setUint16(34, 0, true);
      view.setUint16(36, 0, true);
      view.setUint32(38, 0, true);
      view.setUint32(42, e.localStart, true);
      central.set(e.nameBytes, 46);
      this.parts.push(central);
      this.offset += central.length;
    }

    const eocd = new Uint8Array(22);
    const end = new DataView(eocd.buffer);
    end.setUint32(0, SIG_EOCD, true);
    end.setUint16(4, 0, true);
    end.setUint16(6, 0, true);
    end.setUint16(8, this.entries.length, true);
    end.setUint16(10, this.entries.length, true);
    end.setUint32(12, this.offset - centralStart, true);
    end.setUint32(16, centralStart, true);
    end.setUint16(20, 0, true);
    this.parts.push(eocd);

    return new Blob(this.parts, { type: "application/zip" });
  }
}

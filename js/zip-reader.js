const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const SIG_DESCRIPTOR = 0x08074b50;
const FLAG_UTF8 = 0x0800;
const FLAG_DATA_DESCRIPTOR = 0x0008;

function findEocdOffset(buffer) {
  const minEocd = 22;
  const maxComment = 65535;
  const start = Math.max(0, buffer.byteLength - minEocd - maxComment);
  const view = new DataView(buffer);
  for (let i = buffer.byteLength - minEocd; i >= start; i--) {
    if (view.getUint32(i, true) === SIG_EOCD) return i;
  }
  return -1;
}

function decodeName(bytes, utf8) {
  const dec = new TextDecoder(utf8 ? "utf-8" : "cp437");
  return dec.decode(bytes).replace(/\\/g, "/");
}

export class ZipReader {
  constructor(file) {
    this.file = file;
    this.entries = new Map();
    this._catalogReady = null;
  }

  async loadCatalog() {
    if (this._catalogReady) return this._catalogReady;
    this._catalogReady = this._parseCatalog();
    return this._catalogReady;
  }

  async _parseCatalog() {
    const tailLen = Math.min(this.file.size, 65557);
    const tail = await this.file.slice(this.file.size - tailLen, this.file.size).arrayBuffer();
    const eocdAt = findEocdOffset(tail);
    if (eocdAt < 0) throw new Error("ZIP_END_NOT_FOUND");
    const eocd = new DataView(tail, eocdAt);
    const centralSize = eocd.getUint32(12, true);
    const centralOffset = eocd.getUint32(16, true);
    const count = eocd.getUint16(10, true);
    const centralBuf = await this.file
      .slice(centralOffset, centralOffset + centralSize)
      .arrayBuffer();
    const view = new DataView(centralBuf);
    let pos = 0;
    for (let i = 0; i < count; i++) {
      if (view.getUint32(pos, true) !== SIG_CENTRAL) throw new Error("ZIP_CENTRAL_INVALID");
      const flags = view.getUint16(pos + 8, true);
      const method = view.getUint16(pos + 10, true);
      const crc = view.getUint32(pos + 16, true);
      const compSize = view.getUint32(pos + 20, true);
      const uncompSize = view.getUint32(pos + 24, true);
      const nameLen = view.getUint16(pos + 28, true);
      const extraLen = view.getUint16(pos + 30, true);
      const commentLen = view.getUint16(pos + 32, true);
      const localOffset = view.getUint32(pos + 42, true);
      const nameBytes = new Uint8Array(centralBuf, pos + 46, nameLen);
      const utf8 = (flags & FLAG_UTF8) !== 0;
      const path = decodeName(nameBytes, utf8);
      pos += 46 + nameLen + extraLen + commentLen;
      if (path.endsWith("/")) continue;
      this.entries.set(path, {
        path,
        method,
        flags,
        crc,
        compressedSize: compSize,
        uncompressedSize: uncompSize,
        localHeaderOffset: localOffset,
        hasDataDescriptor: (flags & FLAG_DATA_DESCRIPTOR) !== 0,
      });
    }
  }

  hasPath(path) {
    return this.entries.has(path.replace(/\\/g, "/"));
  }

  listPaths() {
    return [...this.entries.keys()];
  }

  async readBlob(path) {
    await this.loadCatalog();
    const entry = this.entries.get(path.replace(/\\/g, "/"));
    if (!entry) throw new Error("ZIP_ENTRY_MISSING");
    const localHead = await this.file.slice(entry.localHeaderOffset, entry.localHeaderOffset + 30).arrayBuffer();
    const lh = new DataView(localHead);
    if (lh.getUint32(0, true) !== SIG_LOCAL) throw new Error("ZIP_LOCAL_INVALID");
    const nameLen = lh.getUint16(26, true);
    const extraLen = lh.getUint16(28, true);
    const dataStart = entry.localHeaderOffset + 30 + nameLen + extraLen;
    let compSize = entry.compressedSize;
    let dataEnd = dataStart + compSize;
    if (entry.hasDataDescriptor && compSize === 0) {
      const probe = await this.file.slice(dataStart, dataStart + 16).arrayBuffer();
      const dv = new DataView(probe);
      if (dv.getUint32(0, true) === SIG_DESCRIPTOR) {
        compSize = dv.getUint32(8, true);
        dataEnd = dataStart + compSize;
      }
    }
    if (entry.method === 0) {
      return this.file.slice(dataStart, dataEnd);
    }
    const compressed = await this.file.slice(dataStart, dataEnd).arrayBuffer();
    if (entry.method === 8) {
      if (typeof DecompressionStream === "undefined") throw new Error("ZIP_NO_DEFLATE");
      const ds = new DecompressionStream("deflate-raw");
      const out = await new Response(new Blob([compressed]).stream().pipeThrough(ds)).arrayBuffer();
      return new Blob([out]);
    }
    throw new Error("ZIP_UNSUPPORTED_METHOD");
  }

  async readText(path) {
    const blob = await this.readBlob(path);
    return await blob.text();
  }

  async readJSON(path) {
    const text = await this.readText(path);
    return JSON.parse(text);
  }
}

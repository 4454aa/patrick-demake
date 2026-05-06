export const CUSTOM_LEVELS_STORAGE_KEY = "patrick-demake-custom-levels/v1";
export const CUSTOM_LEVEL_PACK_VERSION = 1;
export const CUSTOM_PAGE_SIZE = 12;
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP_METHOD_STORE = 0;
const ZIP_METHOD_DEFLATE = 8;

/**
 * @param {string} text
 * @returns {string}
 */
export function normalizeLevelText(text) {
  return String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

/**
 * @param {string} text
 * @returns {boolean}
 */
export function isParafoxLevelText(text) {
  const normalized = normalizeLevelText(text);
  return /^version 4(?:\n|$)/.test(normalized) && normalized.split("\n").some((line) => line.trim() === "#");
}

/**
 * @param {string} fileName
 * @returns {string}
 */
export function nameFromFileName(fileName) {
  const base = String(fileName ?? "custom_level").replace(/^.*[\\/]/, "");
  return sanitizeCustomLevelName(base.replace(/\.(txt|bytes|json|zip)$/i, ""));
}

/**
 * @param {string | null | undefined} name
 * @returns {string}
 */
export function sanitizeCustomLevelName(name) {
  const cleaned = String(name ?? "").trim();
  return cleaned || "custom_level";
}

/**
 * @param {string} text
 * @returns {Promise<string>}
 */
export async function hashLevelText(text) {
  const normalized = normalizeLevelText(text);
  const cryptoImpl = globalThis.crypto;
  if (cryptoImpl?.subtle && globalThis.TextEncoder) {
    const bytes = new TextEncoder().encode(normalized);
    const digest = await cryptoImpl.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return fallbackHashText(normalized);
}

/**
 * @param {string} text
 * @returns {string}
 */
function fallbackHashText(text) {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

/**
 * @param {string | null | undefined} id
 * @param {string} hash
 * @returns {string}
 */
function normalizeCustomLevelId(id, hash) {
  if (typeof id === "string" && id.startsWith("custom:") && id.length > "custom:".length) {
    return id;
  }
  return `custom:${hash}`;
}

/**
 * @param {{ id?: string, name?: string, text?: string }} input
 * @returns {Promise<any>}
 */
export async function createCustomLevel(input) {
  const text = normalizeLevelText(input.text ?? "");
  if (!isParafoxLevelText(text)) {
    throw new Error("Expected a Parafox version 4 level text");
  }
  const hash = await hashLevelText(text);
  const now = new Date().toISOString();
  return {
    id: normalizeCustomLevelId(input.id, hash),
    name: sanitizeCustomLevelName(input.name),
    text,
    hash,
    source: "custom",
    createdAt: now,
    updatedAt: now
  };
}

/**
 * @param {{ getItem(key: string): string | null } | null | undefined} storage
 * @returns {Array<any>}
 */
export function loadCustomLevels(storage) {
  if (!storage) {
    return [];
  }
  const raw = storage.getItem(CUSTOM_LEVELS_STORAGE_KEY);
  if (!raw) {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const levels = Array.isArray(parsed) ? parsed : parsed.levels;
  if (!Array.isArray(levels)) {
    return [];
  }
  return levels
    .filter((level) => level && typeof level.id === "string" && typeof level.text === "string")
    .map((level) => ({
      id: level.id,
      name: sanitizeCustomLevelName(level.name ?? level.id),
      text: normalizeLevelText(level.text),
      hash: typeof level.hash === "string" ? level.hash : "",
      source: "custom",
      createdAt: typeof level.createdAt === "string" ? level.createdAt : null,
      updatedAt: typeof level.updatedAt === "string" ? level.updatedAt : null
    }));
}

/**
 * @param {{ setItem(key: string, value: string): void } | null | undefined} storage
 * @param {Array<any>} levels
 */
export function saveCustomLevels(storage, levels) {
  if (!storage) {
    return;
  }
  storage.setItem(
    CUSTOM_LEVELS_STORAGE_KEY,
    JSON.stringify({ version: CUSTOM_LEVEL_PACK_VERSION, levels: levels.map(serializeStoredLevel) })
  );
}

/**
 * @param {any} level
 * @returns {any}
 */
function serializeStoredLevel(level) {
  return {
    id: level.id,
    name: level.name,
    text: level.text,
    hash: level.hash,
    source: "custom",
    createdAt: level.createdAt ?? null,
    updatedAt: level.updatedAt ?? null
  };
}

/**
 * @param {Array<any>} existingLevels
 * @param {Array<any>} incomingLevels
 * @returns {{ levels: Array<any>, added: number, updated: number }}
 */
export function mergeCustomLevels(existingLevels, incomingLevels) {
  const levels = existingLevels.map((level) => ({ ...level }));
  let added = 0;
  let updated = 0;
  for (const incoming of incomingLevels) {
    const byId = levels.findIndex((level) => level.id === incoming.id);
    const byName = levels.findIndex((level) => level.name.toLowerCase() === incoming.name.toLowerCase());
    const index = byId >= 0 ? byId : byName;
    if (index >= 0) {
      const previous = levels[index];
      levels[index] = {
        ...incoming,
        id: previous.id,
        createdAt: previous.createdAt ?? incoming.createdAt,
        updatedAt: new Date().toISOString()
      };
      updated += 1;
    } else {
      levels.push({ ...incoming });
      added += 1;
    }
  }
  return { levels, added, updated };
}

/**
 * @param {Array<any>} levels
 * @param {string} levelId
 * @returns {{ levels: Array<any>, removed: boolean }}
 */
export function removeCustomLevel(levels, levelId) {
  const next = levels.filter((level) => level.id !== levelId);
  return { levels: next, removed: next.length !== levels.length };
}

/**
 * @param {Array<any>} levels
 * @param {string} [title]
 * @returns {string}
 */
export function exportCustomLevelPack(levels, title = "Custom Levels") {
  return JSON.stringify(
    {
      version: CUSTOM_LEVEL_PACK_VERSION,
      title,
      levels: levels.map((level) => ({
        id: level.id,
        name: level.name,
        text: level.text
      }))
    },
    null,
    2
  );
}

/**
 * @param {string} jsonText
 * @returns {Promise<{ levels: Array<any>, errors: Array<string> }>}
 */
export async function importCustomLevelPack(jsonText) {
  const errors = [];
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { levels: [], errors: ["JSON parse failed"] };
  }
  const rawLevels = Array.isArray(parsed) ? parsed : parsed.levels;
  if (!Array.isArray(rawLevels)) {
    return { levels: [], errors: ["Invalid custom level pack: expected levels array"] };
  }
  const levels = [];
  for (let index = 0; index < rawLevels.length; index += 1) {
    const raw = rawLevels[index];
    try {
      levels.push(await createCustomLevel({
        id: raw?.id,
        name: raw?.name ?? `level_${index + 1}`,
        text: raw?.text
      }));
    } catch (error) {
      errors.push(`${raw?.name ?? `level_${index + 1}`}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { levels, errors };
}

/**
 * @param {{ name: string, arrayBuffer(): Promise<ArrayBuffer> }} file
 * @returns {Promise<Array<{ name: string, text: string }>>}
 */
export async function extractLevelTextsFromZipFile(file) {
  const entries = await extractTextFilesFromZip(await file.arrayBuffer());
  return entries
    .filter((entry) => /\.(txt|bytes)$/i.test(entry.name) && isParafoxLevelText(entry.text))
    .map((entry) => ({
      name: nameFromFileName(entry.name),
      text: entry.text
    }));
}

/**
 * @param {ArrayBuffer} buffer
 * @returns {Promise<Array<{ name: string, text: string }>>}
 */
export async function extractTextFilesFromZip(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdOffset = findEndOfCentralDirectory(view);
  if (eocdOffset < 0) {
    throw new Error("Invalid zip file: missing central directory");
  }

  const entryCount = view.getUint16(eocdOffset + 10, true);
  const centralOffset = view.getUint32(eocdOffset + 16, true);
  const entries = [];
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (view.getUint32(offset, true) !== ZIP_CENTRAL_SIGNATURE) {
      throw new Error("Invalid zip file: corrupt central directory");
    }
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    const nameBytes = bytes.slice(offset + 46, offset + 46 + nameLength);
    const name = decodeZipFileName(nameBytes, flags);

    if (name && !name.endsWith("/") && !name.includes("__MACOSX/") && /\.(txt|bytes)$/i.test(name)) {
      const text = await readZipEntryText(bytes, view, localHeaderOffset, compressedSize, method);
      entries.push({ name, text });
    }

    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * @param {DataView} view
 * @returns {number}
 */
function findEndOfCentralDirectory(view) {
  const minOffset = Math.max(0, view.byteLength - 0xffff - 22);
  for (let offset = view.byteLength - 22; offset >= minOffset; offset -= 1) {
    if (view.getUint32(offset, true) === ZIP_EOCD_SIGNATURE) {
      return offset;
    }
  }
  return -1;
}

/**
 * @param {Uint8Array} bytes
 * @param {DataView} view
 * @param {number} localHeaderOffset
 * @param {number} compressedSize
 * @param {number} method
 * @returns {Promise<string>}
 */
async function readZipEntryText(bytes, view, localHeaderOffset, compressedSize, method) {
  if (view.getUint32(localHeaderOffset, true) !== ZIP_LOCAL_SIGNATURE) {
    throw new Error("Invalid zip file: corrupt local header");
  }
  const localNameLength = view.getUint16(localHeaderOffset + 26, true);
  const localExtraLength = view.getUint16(localHeaderOffset + 28, true);
  const dataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength;
  const compressed = bytes.slice(dataOffset, dataOffset + compressedSize);
  let decompressed;
  if (method === ZIP_METHOD_STORE) {
    decompressed = compressed;
  } else if (method === ZIP_METHOD_DEFLATE) {
    decompressed = await inflateRaw(compressed);
  } else {
    throw new Error(`Unsupported zip compression method ${method}`);
  }
  return new TextDecoder("utf-8").decode(decompressed);
}

/**
 * @param {Uint8Array} compressed
 * @returns {Promise<Uint8Array>}
 */
async function inflateRaw(compressed) {
  if (!globalThis.DecompressionStream) {
    throw new Error("This browser cannot read deflated zip files");
  }
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * @param {Uint8Array} bytes
 * @param {number} flags
 * @returns {string}
 */
function decodeZipFileName(bytes, flags) {
  const utf8 = (flags & 0x0800) !== 0;
  return new TextDecoder(utf8 ? "utf-8" : "utf-8").decode(bytes).replace(/\\/g, "/");
}

/**
 * @param {any} database
 * @param {Array<any>} customLevels
 */
export function applyCustomLevelsToDatabase(database, customLevels) {
  if (!database.officialPages) {
    database.officialPages = database.pages;
    database.officialPuzzleEntries = database.puzzleEntries;
    database.officialPuzzleData = database.puzzleData;
  }

  const entries = customLevels.map(createCustomLevelEntry);
  const puzzleData = new Map(database.officialPuzzleData);
  for (const entry of entries) {
    puzzleData.set(entry.levelName, entry);
  }

  database.customLevels = customLevels;
  database.customLevelMap = new Map(customLevels.map((level) => [level.id, level]));
  database.customEntries = entries;
  database.puzzleEntries = [...database.officialPuzzleEntries, ...entries];
  database.puzzleData = puzzleData;
  database.pages = [...database.officialPages, ...paginateCustomLevelEntries(entries)];
}

/**
 * @param {any} level
 * @param {number} index
 * @returns {any}
 */
function createCustomLevelEntry(level, index) {
  return {
    levelName: level.id,
    levelId: level.id,
    displayName: level.name,
    levelHash: level.hash,
    source: "custom",
    custom: true,
    music: -1,
    musicArea: -1,
    palette: -1,
    hard: 0,
    eyesJump: false,
    referenceNameWithOldLetter: `C${index + 1}`,
    referenceName: `${index + 1}`,
    referenceLetter: "custom",
    referenceIndex: index + 1,
    pageKey: "custom",
    areaLocalizationId: null
  };
}

/**
 * @param {Array<any>} entries
 * @returns {Array<any>}
 */
function paginateCustomLevelEntries(entries) {
  const pages = [];
  const chunkCount = Math.ceil(entries.length / CUSTOM_PAGE_SIZE);
  for (let index = 0; index < entries.length; index += CUSTOM_PAGE_SIZE) {
    pages.push({
      id: `custom-${Math.floor(index / CUSTOM_PAGE_SIZE) + 1}`,
      label: "custom",
      pageKey: "custom",
      areaLocalizationId: null,
      sequenceIndex: Math.floor(index / CUSTOM_PAGE_SIZE) + 1,
      sequenceCount: chunkCount,
      entries: entries.slice(index, index + CUSTOM_PAGE_SIZE),
      custom: true
    });
  }
  return pages;
}

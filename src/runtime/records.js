export const RECORDS_STORAGE_KEY = "patrick-demake-records/v1";
export const RECORDS_VERSION = 2;
export const RECORD_SOURCE_SHIPPED = "shipped";
export const RECORD_SOURCE_CUSTOM = "custom";

/**
 * @param {string | null | undefined} command
 * @returns {boolean}
 */
export function isReplayDirectionCommand(command) {
  return command === "U" || command === "D" || command === "L" || command === "R";
}

/**
 * @param {string} levelId
 * @param {string | null | undefined} levelHash
 * @returns {string}
 */
export function makeRecordKey(levelId, levelHash = null) {
  return levelHash ? `${levelId}::${levelHash}` : levelId;
}

/**
 * @param {{ getItem(key: string): string | null } | null | undefined} storage
 * @returns {Map<string, any>}
 */
export function loadRecords(storage) {
  if (!storage) {
    return new Map();
  }
  const raw = storage.getItem(RECORDS_STORAGE_KEY);
  if (!raw) {
    return new Map();
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Map();
  }
  return recordsArrayToMap(readRecordEntries(parsed));
}

/**
 * @param {any} parsed
 * @returns {Array<any>}
 */
function readRecordEntries(parsed) {
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (Array.isArray(parsed?.records)) {
    return parsed.records;
  }
  if (parsed && typeof parsed === "object") {
    return Object.entries(parsed)
      .filter(([key]) => key !== "version")
      .map(([key, value]) => ({ storageKey: key, ...value }));
  }
  return [];
}

/**
 * @param {Array<any>} entries
 * @returns {Map<string, any>}
 */
function recordsArrayToMap(entries) {
  const records = new Map();
  for (const entry of entries) {
    const record = normalizeRecord(entry, entry?.storageKey);
    if (record) {
      records.set(makeRecordKey(record.levelId, record.levelHash), record);
    }
  }
  return records;
}

/**
 * @param {any} entry
 * @param {string | null | undefined} storageKey
 * @returns {any | null}
 */
function normalizeRecord(entry, storageKey = null) {
  if (!entry || typeof entry.bestMoveCount !== "number") {
    return null;
  }
  const inputLog = Array.isArray(entry.inputLog) ? entry.inputLog.filter(isReplayDirectionCommand) : [];
  const levelId =
    typeof entry.levelId === "string"
      ? entry.levelId
      : typeof entry.levelName === "string"
        ? entry.levelName
        : typeof storageKey === "string"
          ? storageKey.split("::")[0]
          : null;
  if (!levelId) {
    return null;
  }
  const levelHash = typeof entry.levelHash === "string" && entry.levelHash ? entry.levelHash : null;
  const source = entry.source === RECORD_SOURCE_CUSTOM ? RECORD_SOURCE_CUSTOM : RECORD_SOURCE_SHIPPED;
  return {
    levelId,
    levelName: typeof entry.levelName === "string" ? entry.levelName : levelId,
    displayName: typeof entry.displayName === "string" ? entry.displayName : (entry.levelName ?? levelId),
    source,
    levelHash,
    bestMoveCount: entry.bestMoveCount,
    inputLog,
    inputCount: typeof entry.inputCount === "number" ? entry.inputCount : inputLog.length,
    version: RECORDS_VERSION
  };
}

/**
 * @param {{ setItem(key: string, value: string): void } | null | undefined} storage
 * @param {Map<string, any>} records
 */
export function saveRecords(storage, records) {
  if (!storage) {
    return;
  }
  storage.setItem(RECORDS_STORAGE_KEY, exportRecords(records));
}

/**
 * @param {Map<string, any>} records
 * @param {string | null | undefined} levelId
 * @param {string | null | undefined} levelHash
 * @returns {any | null}
 */
export function getRecord(records, levelId, levelHash = null) {
  if (!levelId) {
    return null;
  }
  return records.get(makeRecordKey(levelId, levelHash)) ?? null;
}

/**
 * @param {Map<string, any>} records
 * @param {string | null | undefined} levelId
 * @returns {any | null}
 */
export function getAnyRecordForLevel(records, levelId) {
  if (!levelId) {
    return null;
  }
  for (const record of records.values()) {
    if (record.levelId === levelId) {
      return record;
    }
  }
  return null;
}

/**
 * @param {Map<string, any>} records
 * @param {string | null | undefined} levelId
 * @param {string | null | undefined} levelHash
 * @returns {boolean}
 */
export function hasHashMismatchRecord(records, levelId, levelHash) {
  if (!levelId || !levelHash) {
    return false;
  }
  for (const record of records.values()) {
    if (record.levelId === levelId && record.levelHash && record.levelHash !== levelHash) {
      return true;
    }
  }
  return false;
}

/**
 * @param {Map<string, any>} records
 * @param {string} levelId
 * @returns {Map<string, any>}
 */
export function deleteRecordsForLevel(records, levelId) {
  const next = new Map();
  for (const [key, record] of records) {
    if (record.levelId !== levelId) {
      next.set(key, record);
    }
  }
  return next;
}

/**
 * Derive a stable replay log from the turns that are currently applied.
 * Undo/redo inputs never appear in `undoStack`; restart resets the effective path,
 * so only turns after the last restart remain relevant for replay-from-fresh.
 *
 * @param {{ undoStack?: Array<{ command?: string | null }> } | null | undefined} state
 * @returns {string[]}
 */
export function deriveReplayInputLog(state) {
  const turns = state?.undoStack ?? [];
  let startIndex = 0;
  for (let index = 0; index < turns.length; index += 1) {
    if (turns[index]?.command === "Restart") {
      startIndex = index + 1;
    }
  }
  const cmds = [];
  let lastGroup = undefined;
  for (let index = startIndex; index < turns.length; index += 1) {
    const turn = turns[index];
    if (!isReplayDirectionCommand(turn.command)) {
      continue;
    }
    if (turn.mpGroup !== undefined && turn.mpGroup === lastGroup) {
      continue;
    }
    lastGroup = turn.mpGroup;
    cmds.push(turn.command);
  }
  return cmds;
}

/**
 * @param {any | null} existing
 * @param {any} candidate
 * @returns {boolean}
 */
export function shouldReplaceRecord(existing, candidate) {
  if (!existing) {
    return true;
  }
  if (candidate.bestMoveCount < existing.bestMoveCount) {
    return true;
  }
  if (candidate.bestMoveCount > existing.bestMoveCount) {
    return false;
  }
  if (candidate.inputCount < existing.inputCount) {
    return true;
  }
  if (candidate.inputCount > existing.inputCount) {
    return false;
  }
  return false;
}

/**
 * @param {Map<string, any>} records
 * @param {{
 *   levelId?: string,
 *   levelName?: string,
 *   displayName?: string,
 *   source?: string,
 *   levelHash?: string | null,
 *   bestMoveCount: number,
 *   inputLog: string[],
 *   inputCount: number,
 *   version?: number
 * }} candidate
 * @returns {{ updated: boolean, record: any }}
 */
export function upsertRecord(records, candidate) {
  const levelId = candidate.levelId ?? candidate.levelName;
  if (!levelId) {
    throw new Error("Cannot store record without a levelId");
  }
  const levelHash = candidate.levelHash ?? null;
  const existing = getRecord(records, levelId, levelHash);
  if (!shouldReplaceRecord(existing, candidate)) {
    return {
      updated: false,
      record: existing
    };
  }
  const stored = {
    levelId,
    levelName: candidate.levelName ?? levelId,
    displayName: candidate.displayName ?? candidate.levelName ?? levelId,
    source: candidate.source === RECORD_SOURCE_CUSTOM ? RECORD_SOURCE_CUSTOM : RECORD_SOURCE_SHIPPED,
    levelHash,
    bestMoveCount: candidate.bestMoveCount,
    inputLog: [...candidate.inputLog].filter(isReplayDirectionCommand),
    inputCount: candidate.inputCount,
    version: RECORDS_VERSION
  };
  records.set(makeRecordKey(stored.levelId, stored.levelHash), stored);
  return {
    updated: true,
    record: stored
  };
}

/**
 * @param {Map<string, any>} records
 * @returns {string}
 */
export function exportRecords(records) {
  const entries = [];
  for (const record of records.values()) {
    entries.push({
      levelId: record.levelId,
      levelName: record.levelName,
      displayName: record.displayName,
      source: record.source,
      levelHash: record.levelHash ?? null,
      bestMoveCount: record.bestMoveCount,
      inputLog: [...record.inputLog],
      inputCount: record.inputCount,
      version: RECORDS_VERSION
    });
  }
  return JSON.stringify({ version: RECORDS_VERSION, records: entries }, null, 2);
}

/**
 * @param {string} jsonText
 * @returns {{ records: Array<any>, errors: Array<string> }}
 */
export function importRecords(jsonText) {
  const errors = [];
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    errors.push("JSON parse failed");
    return { records: [], errors };
  }
  const records = readRecordEntries(parsed)
    .map((entry) => normalizeRecord(entry, entry?.storageKey))
    .filter(Boolean);
  if (records.length === 0 && !Array.isArray(parsed?.records) && !Array.isArray(parsed)) {
    errors.push("Invalid format: expected records array");
  }
  return { records, errors };
}

/**
 * @param {Map<string, any>} currentRecords
 * @param {Array<any>} importedRecords
 * @returns {{ merged: Map<string, any>, imported: number, updated: number, skipped: number }}
 */
export function mergeRecords(currentRecords, importedRecords) {
  let imported = 0;
  let updated = 0;
  let skipped = 0;
  const merged = new Map(currentRecords);
  for (const candidate of importedRecords) {
    const key = makeRecordKey(candidate.levelId, candidate.levelHash);
    const existing = merged.get(key) ?? null;
    if (shouldReplaceRecord(existing, candidate)) {
      merged.set(key, {
        ...candidate,
        version: RECORDS_VERSION
      });
      if (existing) {
        updated += 1;
      } else {
        imported += 1;
      }
    } else {
      skipped += 1;
    }
  }
  return { merged, imported, updated, skipped };
}

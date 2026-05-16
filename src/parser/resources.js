import { parseInvariantBoolean, parseInvariantFloat } from "./invariant.js";
import { parseLocalizationCsv } from "./localization.js";

/** @type {Array<[string, string]>} */
const AREA_ORDER = [
  ["a", "Area_Intro"],
  ["b", "Area_Enter"],
  ["c", "Area_Empty"],
  ["d", "Area_Eat"],
  ["e", "Area_Reference"],
  ["L", "Area_Swap"],
  ["f", "Area_Center"],
  ["g", "Area_Clone"],
  ["h", "Area_Transfer"],
  ["i", "Area_Open"],
  ["j", "Area_Flip"],
  ["k", "Area_Cycle"],
  ["m", "Area_Player"],
  ["n", "Area_Possess"],
  ["o", "Area_Wall"],
  ["p", "Area_InfiniteExit"],
  ["q", "Area_InfiniteEnter"],
  ["r", "Area_MultiInfinite"],
  ["s", "Area_Challenge"],
  ["t", "Area_Appendix"],
  ["u", "Area_Priority"],
  ["v", "Area_Extrude"],
  ["w", "Area_Push"]
];

const AREA_ORDER_INDEX = new Map(AREA_ORDER.map(([key], index) => [key, index]));
const AREA_LOCALIZATION_BY_KEY = new Map(AREA_ORDER);

/**
 * @param {string} referenceNameWithOldLetter
 * @returns {{ letter: string, index: number }}
 */
function parseReference(referenceNameWithOldLetter) {
  const match = /^([A-Za-z]+)(\d+)$/.exec(referenceNameWithOldLetter);
  if (!match) {
    return {
      letter: referenceNameWithOldLetter[0] ?? "?",
      index: Number.POSITIVE_INFINITY
    };
  }
  return {
    letter: match[1],
    index: Number.parseInt(match[2], 10)
  };
}

/**
 * @param {any} left
 * @param {any} right
 * @returns {number}
 */
function comparePuzzleEntries(left, right) {
  const leftGroup = AREA_ORDER_INDEX.get(left.referenceLetter) ?? Number.MAX_SAFE_INTEGER;
  const rightGroup = AREA_ORDER_INDEX.get(right.referenceLetter) ?? Number.MAX_SAFE_INTEGER;
  if (leftGroup !== rightGroup) {
    return leftGroup - rightGroup;
  }
  if (left.referenceIndex !== right.referenceIndex) {
    return left.referenceIndex - right.referenceIndex;
  }
  return left.levelName.localeCompare(right.levelName);
}

/**
 * @param {typeof fetch} fetchImpl
 * @param {string} path
 * @returns {Promise<string>}
 */
async function fetchText(fetchImpl, path) {
  const response = await fetchImpl(path);
  if (!response.ok) {
    throw new Error(`无法读取资源 ${path} (${response.status})`);
  }
  return response.text();
}

/**
 * @param {string} text
 * @returns {{
 *   list: Array<any>,
 *   map: Map<string, any>
 * }}
 */
export function parsePuzzleData(text) {
  const list = [];
  const map = new Map();
  for (const rawLine of text.replace(/\r/g, "").split("\n")) {
    if (!rawLine) {
      continue;
    }
    const parts = rawLine.split(" ");
    const referenceNameWithOldLetter = parts[6];
    const reference = parseReference(referenceNameWithOldLetter);
    const entry = {
      levelName: parts[0],
      music: Number.parseInt(parts[1], 10),
      musicArea: Number.parseInt(parts[2], 10),
      palette: Number.parseInt(parts[3], 10),
      hard: Number.parseInt(parts[4], 10),
      eyesJump: parseInvariantBoolean(parts[5]),
      referenceNameWithOldLetter,
      referenceName: referenceNameWithOldLetter.slice(1),
      referenceLetter: reference.letter,
      referenceIndex: reference.index,
      pageKey: reference.letter,
      areaLocalizationId: AREA_LOCALIZATION_BY_KEY.get(reference.letter) ?? null
    };
    list.push(entry);
    map.set(entry.levelName, entry);
  }
  return { list, map };
}

/**
 * @param {string} text
 * @returns {Array<any>}
 */
export function parsePuzzleLines(text) {
  return text
    .replace(/\r/g, "")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(" ");
      return {
        from: parts[0],
        to: parts[1],
        immediate: parseInvariantBoolean(parts[2])
      };
    });
}

/**
 * @param {string} text
 * @returns {Array<any>}
 */
export function parsePalettes(text) {
  const palettes = [];
  for (const rawLine of text.replace(/\r/g, "").split("\n")) {
    if (!rawLine) {
      continue;
    }
    const parts = rawLine.split(" ");
    if (parts[0] === "palette") {
      palettes.push({});
      continue;
    }
    const current = palettes[palettes.length - 1];
    current[parts[0]] = {
      hue: parseInvariantFloat(parts[1]),
      sat: parseInvariantFloat(parts[2]),
      val: parseInvariantFloat(parts[3])
    };
  }
  return palettes;
}

/**
 * @param {Array<any>} entries
 * @param {number} pageSize
 * @returns {Array<any>}
 */
export function paginatePuzzleEntries(entries, pageSize = 15) {
  /** @type {Map<string, Array<any>>} */
  const groups = new Map();
  for (const entry of [...entries].sort(comparePuzzleEntries)) {
    const key = entry.pageKey;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key)?.push(entry);
  }

  /** @type {Array<any>} */
  const pages = [];
  for (const [key, group] of [...groups.entries()].sort(
    ([left], [right]) =>
      (AREA_ORDER_INDEX.get(left) ?? Number.MAX_SAFE_INTEGER) - (AREA_ORDER_INDEX.get(right) ?? Number.MAX_SAFE_INTEGER) ||
      left.localeCompare(right)
  )) {
    const chunkCount = Math.ceil(group.length / pageSize);
    for (let index = 0; index < group.length; index += pageSize) {
      const chunk = group.slice(index, index + pageSize);
      pages.push({
        id: `${key}-${Math.floor(index / pageSize) + 1}`,
        label: group.length > pageSize ? `${key}${Math.floor(index / pageSize) + 1}` : key,
        pageKey: key,
        areaLocalizationId: AREA_LOCALIZATION_BY_KEY.get(key) ?? null,
        sequenceIndex: Math.floor(index / pageSize) + 1,
        sequenceCount: chunkCount,
        entries: chunk
      });
    }
  }
  return pages;
}

/**
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<any>}
 */
export async function loadGameDatabase(fetchImpl = fetch) {
  const [puzzleDataText, puzzleLinesText, palettesText, localizationText] = await Promise.all([
    fetchText(fetchImpl, "/game-data/puzzle_data.bytes"),
    fetchText(fetchImpl, "/game-data/puzzle_lines.bytes"),
    fetchText(fetchImpl, "/game-data/palettes.bytes"),
    fetchText(fetchImpl, "/game-data/localization.bytes")
  ]);

  const puzzleData = parsePuzzleData(puzzleDataText);
  return {
    puzzleEntries: puzzleData.list,
    puzzleData: puzzleData.map,
    puzzleLines: parsePuzzleLines(puzzleLinesText),
    palettes: parsePalettes(palettesText),
    localization: parseLocalizationCsv(localizationText),
    pages: paginatePuzzleEntries(puzzleData.list)
  };
}

/** @type {Map<string, string> | null} */
let levelsBundleCache = null;

/**
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<Map<string, string>>}
 */
async function ensureLevelsBundle(fetchImpl) {
  if (levelsBundleCache) {
    return levelsBundleCache;
  }
  const json = await fetchText(fetchImpl, "/game-data/levels-bundle.json");
  const bundle = JSON.parse(json);
  levelsBundleCache = new Map(Object.entries(bundle));
  return levelsBundleCache;
}

/**
 * @param {typeof fetch} fetchImpl
 * @param {string} levelName
 * @param {any} [database]
 * @returns {Promise<string>}
 */
export async function loadLevelText(fetchImpl, levelName, database = null) {
  const customLevel = database?.customLevelMap?.get(levelName);
  if (customLevel) {
    return customLevel.text;
  }
  const bundle = await ensureLevelsBundle(fetchImpl);
  const text = bundle.get(levelName);
  if (text == null) {
    throw new Error(`Level not found in bundle: ${levelName}`);
  }
  return text;
}

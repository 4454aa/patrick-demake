/**
 * @param {string} text
 * @returns {Map<string, Map<string, string>>}
 */
export function parseLocalizationCsv(text) {
  const normalized = text.replace(/\r/g, "");
  /** @type {Map<string, Map<string, string>>} */
  const languages = new Map();
  /** @type {string[]} */
  const headers = [];
  let row = 0;
  let column = 0;
  let currentId = "";
  let quoted = false;
  let buffer = "";

  /** @returns {void} */
  const flush = () => {
    const value = buffer;
    buffer = "";
    if (row === 0) {
      if (column > 0) {
        headers.push(value);
        languages.set(value, new Map());
      }
    } else if (column === 0) {
      currentId = value;
    } else if (currentId !== "---" && !currentId.startsWith("Store_")) {
      const language = headers[column - 1];
      if (language) {
        languages.get(language)?.set(currentId, value);
      }
    }
    column += 1;
  };

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === "\n") {
      if (quoted) {
        buffer += char;
      } else {
        flush();
        row += 1;
        column = 0;
      }
      continue;
    }
    if (char === '"') {
      if (quoted && normalized[index + 1] === '"') {
        buffer += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (char === ",") {
      if (quoted) {
        buffer += char;
      } else {
        flush();
      }
      continue;
    }
    buffer += char;
  }

  if (!quoted) {
    flush();
  }

  languages.delete("Translation notes");
  return languages;
}

/**
 * @param {Map<string, Map<string, string>>} languages
 * @param {string} language
 * @param {string} id
 * @returns {string}
 */
export function localize(languages, language, id) {
  return languages.get(language)?.get(id) ?? id;
}

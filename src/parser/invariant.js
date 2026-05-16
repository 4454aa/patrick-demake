/**
 * @param {string} value
 * @returns {boolean}
 */
export function parseInvariantBoolean(value) {
  if (value === "0" || value === "False" || value === "false") {
    return false;
  }
  if (value === "1" || value === "True" || value === "true") {
    return true;
  }
  throw new Error(`Unable to parse bool: ${value}`);
}

/**
 * @param {string} value
 * @returns {number}
 */
export function parseInvariantFloat(value) {
  const number = Number.parseFloat(value);
  if (!Number.isFinite(number)) {
    throw new Error(`Unable to parse float: ${value}`);
  }
  return number;
}

/**
 * @param {number} value
 * @returns {string}
 */
export function floatToInvariantString(value) {
  return `${value}`;
}

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * @param {number} a
 * @param {number} b
 * @param {number} t
 * @returns {number}
 */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * @param {number} a
 * @param {number} b
 * @param {number} value
 * @returns {number}
 */
export function inverseLerp(a, b, value) {
  if (a === b) {
    return 0;
  }
  return (value - a) / (b - a);
}

/**
 * @param {number} value
 * @returns {number}
 */
export function signInt(value) {
  if (value > 0) {
    return 1;
  }
  if (value < 0) {
    return -1;
  }
  return 0;
}

/**
 * @param {number} h
 * @param {number} s
 * @param {number} v
 * @returns {{ r: number, g: number, b: number }}
 */
export function hsvToRgb(h, s, v) {
  const hue = ((h % 1) + 1) % 1;
  const i = Math.floor(hue * 6);
  const f = hue * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);

  switch (i % 6) {
    case 0:
      return { r: v, g: t, b: p };
    case 1:
      return { r: q, g: v, b: p };
    case 2:
      return { r: p, g: v, b: t };
    case 3:
      return { r: p, g: q, b: v };
    case 4:
      return { r: t, g: p, b: v };
    default:
      return { r: v, g: p, b: q };
  }
}

/**
 * @param {number} h
 * @param {number} s
 * @param {number} v
 * @returns {string}
 */
export function hsvToCss(h, s, v) {
  const { r, g, b } = hsvToRgb(h, s, v);
  return `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)})`;
}

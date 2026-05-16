import { FloorType, getExitBlock } from "../core/model.js";
import { clamp, hsvToRgb, lerp } from "../parser/invariant.js";

export const MAX_SUBLEVEL_RENDER_DEPTH = 4;
export const MIN_EXPANDED_NESTED_SIZE = 48;
const MIN_FULL_NESTED_SIZE = 36;
const MIN_COMPACT_NESTED_SIZE = 18;
const MIN_TEXTURED_COMPACT_CELL_SIZE = 8;
const MAX_COMPACT_PREVIEWS_PER_FRAME = 24;
const MAX_NESTED_LEVEL_CACHE_ENTRIES = 160;
const MAX_NESTED_LEVEL_CACHE_PIXELS = 640 * 640;
const MAX_NESTED_LEVEL_CACHE_TOTAL_PIXELS = 8 * 1024 * 1024;

export const ENTER_LENGTH = 0.5;
export const TRANSFER_LENGTH = 0.2;
const FOCUS_FRACT_NORMAL = 0.82;
const MAX_CANVAS_PIXEL_RATIO = 1.5;
const MODULATED_TEXTURE_CACHE_MAX_ENTRIES = 512;
const MODULATED_TEXTURE_CACHE_MAX_PIXELS = 384 * 384;
const MODULATED_TEXTURE_COLOR_QUANT = 4;

const RENDER_DEBUG_DEFAULT_SLOW_MS = 45;
const RENDER_DEBUG_DEFAULT_MAX_FRAMES = 240;
const RENDER_DEBUG_DEFAULT_MAX_SAMPLES = 16;

/**
 * @typedef {"canonical" | "flipY"} WallBigQuadsMode
 */

const TEXTURE_FILES = {
  blockGradient: "center_gradient.png",
  playerButtonEyesLarge: "button_player_x_only_eyes.png",
  playerButtonEyes: "button_player_x_only_eyes_small.png",
  info: "info_only_i.png",
  eyeLeftLarge: "eye1.png",
  eyeLeft: "eye1_small.png",
  possessEyeLarge: "possess_eye_1.png",
  possessEye: "possess_eye_1_small.png",
  mouthFrowny: "frowny_mouth.png",
  mouthFrownyFlip: "frowny_mouth_flip.png",
  mouthMeh: "meh_mouth.png",
  mouthMehFlip: "meh_mouth_flip.png",
  mouthOpen: "open_mouth.png",
  mouthOpenFlip: "open_mouth_flip.png",
  mouthSquare: "square_mouth.png",
  mouthSquareFlip: "square_mouth_flip.png",
  mouthV: "v_mouth.png",
  infParticle: "infinity_particle.png",
  infParticleOutline: "infinity_particle_outline.png"
};

const WALL_BIG_TEXTURE_FILES = [
  "topleft.png",
  "top.png",
  "topright.png",
  "left.png",
  "wall_0.png",
  "right.png",
  "bottomleft.png",
  "bottom.png",
  "bottomright.png",
  "inner_topleft.png",
  "inner_topright.png",
  "inner_bottomleft.png",
  "inner_bottomright.png"
];

/**
 * @param {string} filename
 * @returns {string}
 */
function textureUrl(filename) {
  return `/game-data/textures/${encodeURIComponent(filename)}`;
}

/**
 * @returns {string}
 */
function wallBigDataUrl() {
  return "/game-data/wall_big_data.bytes";
}

/**
 * Filled block colors are computed from Unity Color values, while CSS color
 * literals are interpreted as display/sRGB values. Encoding the block fill keeps
 * the C# HSV/value math intact without adding renderer-only brightness boosts.
 *
 * @param {number} value
 * @returns {number}
 */
function linearToSrgb(value) {
  const channel = clamp(value, 0, 1);
  if (channel <= 0.0031308) {
    return channel * 12.92;
  }
  return 1.055 * channel ** (1 / 2.4) - 0.055;
}

/**
 * @param {any} renderer
 * @param {number} width
 * @param {number} height
 * @returns {{ canvas: HTMLCanvasElement, context: CanvasRenderingContext2D, width: number, height: number } | null}
 */
function getTintSurface(renderer, width, height) {
  if (typeof renderer.getTintSurface === "function") {
    return renderer.getTintSurface(width, height);
  }
  if (typeof document === "undefined") {
    return null;
  }
  const pixelRatio = renderer.pixelRatio ?? 1;
  const pixelWidth = Math.max(1, Math.ceil(width * pixelRatio));
  const pixelHeight = Math.max(1, Math.ceil(height * pixelRatio));
  if (!renderer.tintCanvas) {
    renderer.tintCanvas = document.createElement("canvas");
    renderer.tintContext = renderer.tintCanvas.getContext("2d");
  }
  if (!renderer.tintContext) {
    return null;
  }
  if (renderer.tintCanvas.width !== pixelWidth || renderer.tintCanvas.height !== pixelHeight) {
    renderer.tintCanvas.width = pixelWidth;
    renderer.tintCanvas.height = pixelHeight;
  }
  const context = renderer.tintContext;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.globalAlpha = 1;
  context.globalCompositeOperation = "source-over";
  context.clearRect(0, 0, pixelWidth, pixelHeight);
  return { canvas: renderer.tintCanvas, context, width: pixelWidth, height: pixelHeight };
}

/**
 * @param {any} renderer
 * @param {CanvasImageSource} texture
 * @param {number} x
 * @param {number} y
 * @param {number} width
 * @param {number} height
 * @param {string} tintCss
 * @param {number} alpha
 */
function drawTintedTexture(renderer, texture, x, y, width, height, tintCss, alpha) {
  const context = renderer.context;
  const tintSurface = getTintSurface(renderer, width, height);
  const drawAlpha = clamp(alpha, 0, 1);

  if (!tintSurface) {
    context.save();
    context.globalAlpha = drawAlpha;
    context.imageSmoothingEnabled = true;
    context.drawImage(texture, x, y, width, height);
    context.restore();
    return;
  }

  const tintContext = tintSurface.context;
  tintContext.imageSmoothingEnabled = true;
  tintContext.drawImage(texture, 0, 0, tintSurface.width, tintSurface.height);
  tintContext.globalCompositeOperation = "source-in";
  tintContext.fillStyle = tintCss;
  tintContext.fillRect(0, 0, tintSurface.width, tintSurface.height);
  tintContext.globalCompositeOperation = "source-over";

  const prevAlpha = context.globalAlpha;
  const prevSmoothing = context.imageSmoothingEnabled;
  context.globalAlpha = drawAlpha;
  context.imageSmoothingEnabled = true;
  context.drawImage(tintSurface.canvas, 0, 0, tintSurface.width, tintSurface.height, x, y, width, height);
  context.globalAlpha = prevAlpha;
  context.imageSmoothingEnabled = prevSmoothing;
}

/**
 * Draws a texture the way Unity's DrawTexture material is used for wall art:
 * texture RGB modulates the tint color, while the texture/tint alpha remains
 * the output mask. The normal source-in tint path would erase wall highlights.
 *
 * @param {any} renderer
 * @param {CanvasImageSource} texture
 * @param {number} x
 * @param {number} y
 * @param {number} width
 * @param {number} height
 * @param {{ r: number, g: number, b: number }} tintRgb
 * @param {number} alpha
 * @param {boolean} imageSmoothing
 * @param {boolean} flipY
 * @param {boolean} flipX
 */
function drawModulatedTexture(renderer, texture, x, y, width, height, tintRgb, alpha, imageSmoothing, flipY = false, flipX = false) {
  const context = renderer.context;
  const tintSurface = getTintSurface(renderer, width, height);
  const drawAlpha = clamp(alpha, 0, 1);
  const tintCss = renderer.rgbToCss(tintRgb, 1);

  if (!tintSurface) {
    context.save();
    context.fillStyle = tintCss;
    context.fillRect(x, y, width, height);
    context.globalCompositeOperation = "multiply";
    context.globalAlpha = drawAlpha;
    context.imageSmoothingEnabled = imageSmoothing;
    if (flipY || flipX) {
      context.translate(flipX ? x * 2 + width : 0, flipY ? y * 2 + height : 0);
      context.scale(flipX ? -1 : 1, flipY ? -1 : 1);
      context.drawImage(texture, x, y, width, height);
    } else {
      context.drawImage(texture, x, y, width, height);
    }
    context.globalCompositeOperation = "source-over";
    context.restore();
    return;
  }

  const tintContext = tintSurface.context;
  tintContext.imageSmoothingEnabled = imageSmoothing;
  if (flipY || flipX) {
    tintContext.save();
    tintContext.translate(flipX ? tintSurface.width : 0, flipY ? tintSurface.height : 0);
    tintContext.scale(flipX ? -1 : 1, flipY ? -1 : 1);
    tintContext.drawImage(texture, 0, 0, tintSurface.width, tintSurface.height);
    tintContext.restore();
  } else {
    tintContext.drawImage(texture, 0, 0, tintSurface.width, tintSurface.height);
  }
  tintContext.globalCompositeOperation = "multiply";
  tintContext.fillStyle = tintCss;
  tintContext.fillRect(0, 0, tintSurface.width, tintSurface.height);
  tintContext.globalCompositeOperation = "destination-in";
  if (flipY || flipX) {
    tintContext.save();
    tintContext.translate(flipX ? tintSurface.width : 0, flipY ? tintSurface.height : 0);
    tintContext.scale(flipX ? -1 : 1, flipY ? -1 : 1);
    tintContext.drawImage(texture, 0, 0, tintSurface.width, tintSurface.height);
    tintContext.restore();
  } else {
    tintContext.drawImage(texture, 0, 0, tintSurface.width, tintSurface.height);
  }
  tintContext.globalCompositeOperation = "destination-in";
  tintContext.fillStyle = `rgba(0, 0, 0, ${drawAlpha})`;
  tintContext.fillRect(0, 0, tintSurface.width, tintSurface.height);
  tintContext.globalCompositeOperation = "source-over";

  const prevSmoothing2 = context.imageSmoothingEnabled;
  context.imageSmoothingEnabled = imageSmoothing;
  context.drawImage(tintSurface.canvas, 0, 0, tintSurface.width, tintSurface.height, x, y, width, height);
  context.imageSmoothingEnabled = prevSmoothing2;
}

/**
 * @param {number} value
 * @returns {number}
 */
function quantizeTextureColor(value) {
  return Math.min(255, Math.round(Math.round(clamp(value, 0, 1) * 255) / MODULATED_TEXTURE_COLOR_QUANT) * MODULATED_TEXTURE_COLOR_QUANT);
}

/**
 * @param {any} renderer
 * @param {string} filename
 * @param {CanvasImageSource} texture
 * @param {number} x
 * @param {number} y
 * @param {number} width
 * @param {number} height
 * @param {{ r: number, g: number, b: number }} tintRgb
 * @param {number} alpha
 * @param {boolean} imageSmoothing
 * @param {boolean} flipY
 * @param {boolean} flipX
 * @returns {boolean}
 */
function drawCachedModulatedTexture(renderer, filename, texture, x, y, width, height, tintRgb, alpha, imageSmoothing, flipY = false, flipX = false) {
  if (typeof document === "undefined") {
    return false;
  }
  const sourceWidth = Math.max(1, Math.ceil(texture.naturalWidth || texture.videoWidth || texture.width || width));
  const sourceHeight = Math.max(1, Math.ceil(texture.naturalHeight || texture.videoHeight || texture.height || height));
  if (sourceWidth * sourceHeight > MODULATED_TEXTURE_CACHE_MAX_PIXELS) {
    return false;
  }
  if (!renderer.modulatedTextureCache || renderer.modulatedTextureCacheAssetVersion !== renderer.assetVersion) {
    renderer.modulatedTextureCache = new Map();
    renderer.modulatedTextureCacheAssetVersion = renderer.assetVersion;
  }

  const r = quantizeTextureColor(tintRgb.r);
  const g = quantizeTextureColor(tintRgb.g);
  const b = quantizeTextureColor(tintRgb.b);
  const a = Math.round(clamp(alpha, 0, 1) * 255);
  const key = `${filename}|${sourceWidth}x${sourceHeight}|${r},${g},${b},${a}|${imageSmoothing ? 1 : 0}|${flipY ? 1 : 0}|${flipX ? 1 : 0}`;
  let cached = renderer.modulatedTextureCache.get(key);
  if (!cached) {
    cached = document.createElement("canvas");
    cached.width = sourceWidth;
    cached.height = sourceHeight;
    const cachedContext = cached.getContext("2d");
    if (!cachedContext) {
      return false;
    }
    cachedContext.imageSmoothingEnabled = imageSmoothing;
    if (flipY || flipX) {
      cachedContext.save();
      cachedContext.translate(flipX ? sourceWidth : 0, flipY ? sourceHeight : 0);
      cachedContext.scale(flipX ? -1 : 1, flipY ? -1 : 1);
      cachedContext.drawImage(texture, 0, 0, sourceWidth, sourceHeight);
      cachedContext.restore();
    } else {
      cachedContext.drawImage(texture, 0, 0, sourceWidth, sourceHeight);
    }
    cachedContext.globalCompositeOperation = "multiply";
    cachedContext.fillStyle = `rgb(${r} ${g} ${b})`;
    cachedContext.fillRect(0, 0, sourceWidth, sourceHeight);
    cachedContext.globalCompositeOperation = "destination-in";
    if (flipY || flipX) {
      cachedContext.save();
      cachedContext.translate(flipX ? sourceWidth : 0, flipY ? sourceHeight : 0);
      cachedContext.scale(flipX ? -1 : 1, flipY ? -1 : 1);
      cachedContext.drawImage(texture, 0, 0, sourceWidth, sourceHeight);
      cachedContext.restore();
    } else {
      cachedContext.drawImage(texture, 0, 0, sourceWidth, sourceHeight);
    }
    cachedContext.globalCompositeOperation = "destination-in";
    cachedContext.fillStyle = `rgba(0, 0, 0, ${a / 255})`;
    cachedContext.fillRect(0, 0, sourceWidth, sourceHeight);
    cachedContext.globalCompositeOperation = "source-over";

    renderer.modulatedTextureCache.set(key, cached);
    if (renderer.modulatedTextureCache.size > MODULATED_TEXTURE_CACHE_MAX_ENTRIES) {
      const oldestKey = renderer.modulatedTextureCache.keys().next().value;
      renderer.modulatedTextureCache.delete(oldestKey);
    }
  }

  const context = renderer.context;
  const prevSmoothing = context.imageSmoothingEnabled;
  context.imageSmoothingEnabled = imageSmoothing;
  context.drawImage(cached, 0, 0, sourceWidth, sourceHeight, x, y, width, height);
  context.imageSmoothingEnabled = prevSmoothing;
  return true;
}

/**
 * @param {any} block
 * @param {number} depth
 * @param {Set<number> | null | undefined} path
 * @param {number} previewSize
 * @param {number} compactCount
 * @returns {boolean}
 */
function shouldDrawCompactNestedLevel(block, depth, path, previewSize, compactCount) {
  void path;
  if (!block?.subLevel) {
    return false;
  }
  if (previewSize < MIN_COMPACT_NESTED_SIZE) {
    return false;
  }
  if (depth >= MAX_SUBLEVEL_RENDER_DEPTH + 1) {
    return false;
  }
  return compactCount < MAX_COMPACT_PREVIEWS_PER_FRAME;
}

/**
 * @param {any} level
 * @param {number} x
 * @param {number} y
 * @returns {boolean}
 */
function isSolidWallNeighbor(level, x, y) {
  if (!level) {
    return true;
  }
  if (x < 0 || x >= level.width || y < 0 || y >= level.height) {
    return true;
  }
  const block = level.blocks?.[y]?.[x] ?? null;
  return Boolean(block && !block.subLevel);
}

/**
 * Mirrors C# WallShadowCull: interior wall shadows hidden behind adjacent walls
 * do not need a separate shadow pass.
 *
 * @param {any} block
 * @param {boolean} flipH
 * @returns {boolean}
 */
function shouldCullWallShadow(block, flipH = false) {
  if (block?.kind !== "wall" || !block.outerLevel) {
    return false;
  }
  const level = block.outerLevel;
  const x = block.xpos;
  const y = block.ypos;
  const edgeX = flipH ? x === 0 : x === level.width - 1;
  const neighborX = flipH ? x - 1 : x + 1;
  const horizontalSolid = edgeX || isSolidWallNeighbor(level, neighborX, y);
  const upSolid = y === 0 || isSolidWallNeighbor(level, x, y - 1);
  if (!horizontalSolid || !upSolid) {
    return false;
  }
  if (!edgeX && y !== 0) {
    return isSolidWallNeighbor(level, neighborX, y - 1);
  }
  return true;
}

/**
 * @param {boolean} up
 * @param {boolean} down
 * @param {boolean} left
 * @param {boolean} right
 * @param {boolean} topRight
 * @param {boolean} topLeft
 * @param {boolean} bottomRight
 * @param {boolean} bottomLeft
 * @returns {number}
 */
export function computeAutotileIndex(up, down, left, right, topRight, topLeft, bottomRight, bottomLeft) {
  const mask =
    Number(topLeft) |
    Number(up) * 2 |
    Number(topRight) * 4 |
    Number(left) * 8 |
    Number(right) * 16 |
    Number(bottomLeft) * 32 |
    Number(down) * 64 |
    Number(bottomRight) * 128;
  let result = 0;
  if (mask >= 0) result = 47;
  if (mask >= 2) result = 1;
  if (mask >= 8) result = 2;
  if (mask >= 10) result = 3;
  if (mask >= 11) result = 4;
  if (mask >= 16) result = 5;
  if (mask >= 18) result = 6;
  if (mask >= 22) result = 7;
  if (mask >= 24) result = 8;
  if (mask >= 26) result = 9;
  if (mask >= 27) result = 10;
  if (mask >= 30) result = 11;
  if (mask >= 31) result = 12;
  if (mask >= 64) result = 13;
  if (mask >= 66) result = 14;
  if (mask >= 72) result = 15;
  if (mask >= 74) result = 16;
  if (mask >= 75) result = 17;
  if (mask >= 80) result = 18;
  if (mask >= 82) result = 19;
  if (mask >= 86) result = 20;
  if (mask >= 88) result = 21;
  if (mask >= 90) result = 22;
  if (mask >= 91) result = 23;
  if (mask >= 94) result = 24;
  if (mask >= 95) result = 25;
  if (mask >= 104) result = 26;
  if (mask >= 106) result = 27;
  if (mask >= 107) result = 28;
  if (mask >= 120) result = 29;
  if (mask >= 122) result = 30;
  if (mask >= 123) result = 31;
  if (mask >= 126) result = 32;
  if (mask >= 127) result = 33;
  if (mask >= 208) result = 34;
  if (mask >= 210) result = 35;
  if (mask >= 214) result = 36;
  if (mask >= 216) result = 37;
  if (mask >= 218) result = 38;
  if (mask >= 219) result = 39;
  if (mask >= 222) result = 40;
  if (mask >= 223) result = 41;
  if (mask >= 248) result = 42;
  if (mask >= 250) result = 43;
  if (mask >= 251) result = 44;
  if (mask >= 254) result = 45;
  if (mask >= 255) result = 46;
  return result;
}

/**
 * @param {any} block
 * @param {boolean} [flipH]
 * @returns {number}
 */
export function computeWallTileIndex(block, flipH = false) {
  const level = block?.outerLevel ?? null;
  const x = block?.xpos ?? 0;
  const y = block?.ypos ?? 0;
  // Level parsing already converts C#'s y-up coordinates into row indices, so
  // logical "up" is the row above on the Canvas grid.
  const up = isSolidWallNeighbor(level, x, y - 1);
  const down = isSolidWallNeighbor(level, x, y + 1);
  const left = isSolidWallNeighbor(level, x - 1, y);
  const right = isSolidWallNeighbor(level, x + 1, y);
  const topRight = up && right && isSolidWallNeighbor(level, x + 1, y - 1);
  const topLeft = up && left && isSolidWallNeighbor(level, x - 1, y - 1);
  const bottomRight = down && right && isSolidWallNeighbor(level, x + 1, y + 1);
  const bottomLeft = down && left && isSolidWallNeighbor(level, x - 1, y + 1);
  return flipH
    ? computeAutotileIndex(up, down, right, left, topLeft, topRight, bottomLeft, bottomRight)
    : computeAutotileIndex(up, down, left, right, topRight, topLeft, bottomRight, bottomLeft);
}

/**
 * @param {string} text
 * @returns {Array<{ TL: number, TR: number, BL: number, BR: number }>}
 */
export function parseWallBigData(text) {
  return text
    .replace(/\r/g, "")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [TL, TR, BL, BR] = line.trim().split(/\s+/).map((value) => Number.parseInt(value, 10));
      return { TL, TR, BL, BR };
    });
}

/**
 * @param {any} block
 * @returns {number}
 */
export function resolveCloneIntensity(block) {
  if (!block?.subLevel) {
    return 0;
  }
  return getExitBlock(block.subLevel) === block ? 0 : 1;
}

/**
 * @param {any} block
 * @returns {number}
 */
export function resolveFlipIntensity(block) {
  if (!block) {
    return 0;
  }
  if (block.specialEffect === 2 || block.specialEffect === 3) {
    return 1;
  }
  return block.flipH || block.tempFlipH ? 1 : 0;
}

/**
 * @param {any} block
 * @returns {number}
 */
export function computeInfinitySymbolCount(block) {
  if (!block) {
    return 0;
  }
  if (block.isSomeInfEnterBlock) {
    return Math.max(0, (block.someInfEnterNum ?? -1) + 1);
  }
  if (block.isSomeInfExitBlock) {
    const index = block.subLevel?.infExitBlocks?.indexOf?.(block) ?? -1;
    return index >= 0 ? index + 1 : 1;
  }
  if (block.generatedInf || block.subLevel?.infZone) {
    return 1;
  }
  return 0;
}

/**
 * @param {any} block
 * @returns {boolean}
 */
export function shouldDrawInfinityEffect(block) {
  return Boolean(
    block &&
      (block.isSomeInfEnterBlock || block.isSomeInfExitBlock || block.generatedInf || block.subLevel?.infZone)
  );
}

/**
 * @param {any} level
 * @returns {{ leftWall: boolean, rightWall: boolean, upWall: boolean, downWall: boolean }}
 */
export function computeLevelWallMask(level) {
  if (
    typeof level?.leftWall === "boolean" &&
    typeof level?.rightWall === "boolean" &&
    typeof level?.upWall === "boolean" &&
    typeof level?.downWall === "boolean"
  ) {
    return {
      leftWall: level.leftWall,
      rightWall: level.rightWall,
      upWall: level.upWall,
      downWall: level.downWall
    };
  }

  let leftWall = true;
  let rightWall = true;
  let upWall = true;
  let downWall = true;

  for (let y = 0; y < level.height; y += 1) {
    const left = level.blocks?.[y]?.[0] ?? null;
    const right = level.blocks?.[y]?.[level.width - 1] ?? null;
    if (!left || left.subLevel) {
      leftWall = false;
    }
    if (!right || right.subLevel) {
      rightWall = false;
    }
  }

  for (let x = 0; x < level.width; x += 1) {
    const top = level.blocks?.[0]?.[x] ?? null;
    const bottom = level.blocks?.[level.height - 1]?.[x] ?? null;
    if (!top || top.subLevel) {
      upWall = false;
    }
    if (!bottom || bottom.subLevel) {
      downWall = false;
    }
  }

  level.leftWall = leftWall;
  level.rightWall = rightWall;
  level.upWall = upWall;
  level.downWall = downWall;

  return { leftWall, rightWall, upWall, downWall };
}

  /**
 * Return the block color after parser/palette application, without any
 * renderer-only player recoloring.
 *
 * @param {any} block
 * @returns {{ hue: number, sat: number, val: number }}
 */
export function resolveDrawBaseHsv(block) {
  return {
    hue: ((block?.hue ?? 0) % 1 + 1) % 1,
    sat: clamp(block?.sat ?? 0, 0, 1),
    val: clamp(block?.val ?? 0.8, 0, 1)
  };
}

/**
 * @param {number} fractionOfScreen
 * @param {number} [offset]
 * @returns {number}
 */
function log20Fraction(fractionOfScreen, offset = 0.005) {
  return Math.log(Math.max(fractionOfScreen + offset, 0.00001)) / Math.log(20);
}

/**
 * Mirrors Draw.ComputeBlockColor(...) for normal block surfaces.
 *
 * @param {any} block
 * @param {number} fractionOfScreen
 * @param {number} [cloneIntensity]
 * @returns {{ hue: number, sat: number, val: number }}
 */
export function computeDrawBlockHsv(block, fractionOfScreen, cloneIntensity = resolveCloneIntensity(block)) {
  if (block?.kind === "wall") {
    return { hue: 0.55, sat: 0.13, val: 0.29 };
  }

  const base = resolveDrawBaseHsv(block);
  let sat = base.sat;
  let val = base.val;
  val *= -0.25 * log20Fraction(fractionOfScreen, 0.005) + 0.5;
  val *= 0.9;

  if (block?.isSomeInfExitBlock) {
    val *= 0.55;
  } else {
    val += 0.42 * cloneIntensity;
    sat *= 1 - 0.24 * cloneIntensity;
  }

  return {
    hue: base.hue,
    sat: clamp(sat, 0, 1),
    val: clamp(val, 0, 1)
  };
}

/**
 * Mirrors Draw.LineColor(...), used by frames, borders, and floor linework.
 *
 * @param {any} block
 * @param {number} fractionOfScreen
 * @param {boolean} active
 * @returns {{ hue: number, sat: number, val: number }}
 */
export function computeDrawLineHsv(block, fractionOfScreen, active) {
  if (!block || block.kind === "wall") {
    return { hue: 0.55, sat: 0.08, val: active ? 0.72 : 0.2 };
  }

  const base = resolveDrawBaseHsv(block);
  let val = Math.max(base.val, 0.4);
  val *= -0.4 * log20Fraction(fractionOfScreen, 0) + 0.8;

  if (active) {
    return {
      hue: base.hue,
      sat: clamp(base.sat * 0.85, 0, 1),
      val: clamp(val * 0.9, 0, 1)
    };
  }

  return {
    hue: base.hue,
    sat: base.sat,
    val: clamp(val * 0.25, 0, 1)
  };
}

/**
 * Mirrors Draw.ComputeWallColor(...) for walls inside a colored room.
 *
 * @param {any} parentBlock
 * @param {number} fractionOfScreen
 * @param {number} [cloneIntensity]
 * @returns {{ hue: number, sat: number, val: number }}
 */
export function computeDrawWallHsv(parentBlock, fractionOfScreen, cloneIntensity = resolveCloneIntensity(parentBlock)) {
  if (!parentBlock) {
    return { hue: 0.55, sat: 0.12, val: 0.5 };
  }

  const base = resolveDrawBaseHsv(parentBlock);
  let sat = base.sat;
  let val = 1;
  val *= -0.25 * log20Fraction(fractionOfScreen, 0.005) + 0.5;
  val *= base.val;
  val *= 2.0;

  if (parentBlock.isSomeInfExitBlock) {
    val *= 0.55;
  } else {
    val += 0.4 * cloneIntensity;
    sat *= 1 - 0.18 * cloneIntensity;
  }

  return {
    hue: base.hue,
    sat: clamp(sat, 0, 1),
    val: clamp(val, 0, 1)
  };
}

/**
 * @param {any} level
 * @param {number} y
 * @returns {number}
 */
function toCSharpY(level, y) {
  return (level?.height ?? 1) - 1 - y;
}

/**
 * @param {number} value
 * @returns {number}
 */
function cleanSignedZero(value) {
  return Object.is(value, -0) ? 0 : value;
}

/**
 * Mirrors Projection.ComputeProjection for JS' screen-space level coordinates.
 *
 * @param {Array<any>} trail
 * @returns {{ xscale: number, yscale: number, dx: number, dy: number } | null}
 */
export function computeProjectionFromTrail(trail) {
  if (!Array.isArray(trail) || trail.length === 0) {
    return null;
  }

  if (trail.length === 1 && trail[0].moveType === "Slide") {
    return {
      dx: -(trail[0].dx ?? 0),
      dy: -(trail[0].dy ?? 0),
      xscale: 1,
      yscale: 1
    };
  }

  const moves = trail.filter((move) => move.moveType !== "Slide");
  if (moves.length === 0) {
    return null;
  }

  let dx = 0;
  let dy = 0;
  let xscale = 1;
  let yscale = 1;
  let flipSign = 1;

  for (let index = moves.length - 1; index >= 0; index -= 1) {
    const move = moves[index];
    const csDx = move.dx ?? 0;
    const csDy = -(move.dy ?? 0);

    if (move.moveType === "Enter") {
      const toLevel = move.toLevel;
      if (!toLevel) {
        return null;
      }
      if (csDx !== 0) {
        dx = ((xscale * toLevel.width + 1) / 2) * flipSign * -csDx;
        if (move.toLevelBlock?.flipH) {
          flipSign *= -1;
        }
        dy += (toCSharpY(toLevel, move.toY) - (toLevel.height - 1) / 2) * yscale;
      } else if (csDy !== 0) {
        dy = csDy * ((yscale * toLevel.height + 1) / 2);
        dx += (0 - (move.toX - (toLevel.width - 1) / 2)) * xscale * flipSign;
        if (move.toLevelBlock?.flipH) {
          flipSign *= -1;
        }
      }
      xscale *= toLevel.width;
      yscale *= toLevel.height;
    } else if (move.moveType === "Exit") {
      const fromLevel = move.fromLevel;
      if (!fromLevel) {
        return null;
      }
      xscale /= fromLevel.width;
      yscale /= fromLevel.height;
      if (csDx !== 0) {
        dx = -csDx * (0.5 + xscale / 2) * flipSign;
        if (move.shed) {
          dx = -csDx * (-0.5 + xscale / 2) * flipSign;
        }
        if (move.fromLevelBlock?.flipH) {
          flipSign *= -1;
        }
        dy += (0 - (toCSharpY(fromLevel, move.fromY) - (fromLevel.height - 1) / 2)) * yscale;
      } else if (csDy !== 0) {
        dy = csDy * (0.5 + yscale / 2);
        if (move.shed) {
          dy = csDy * (-0.5 + yscale / 2);
        }
        if (move.fromLevelBlock?.flipH) {
          flipSign *= -1;
        }
        dx += (move.fromX - (fromLevel.width - 1) / 2) * xscale * flipSign;
      }
    }
  }

  return { xscale, yscale, dx, dy };
}

/**
 * @param {CanvasRenderingContext2D} context
 * @param {number} x
 * @param {number} y
 * @param {number} width
 * @param {number} height
 * @param {{ topLeft: number, topRight: number, bottomRight: number, bottomLeft: number }} radius
 */
function traceRoundedRect(context, x, y, width, height, radius) {
  const topLeft = Math.max(0, Math.min(radius.topLeft, width / 2, height / 2));
  const topRight = Math.max(0, Math.min(radius.topRight, width / 2, height / 2));
  const bottomRight = Math.max(0, Math.min(radius.bottomRight, width / 2, height / 2));
  const bottomLeft = Math.max(0, Math.min(radius.bottomLeft, width / 2, height / 2));
  context.beginPath();
  context.moveTo(x + topLeft, y);
  context.lineTo(x + width - topRight, y);
  if (topRight > 0) {
    context.arcTo(x + width, y, x + width, y + topRight, topRight);
  }
  context.lineTo(x + width, y + height - bottomRight);
  if (bottomRight > 0) {
    context.arcTo(x + width, y + height, x + width - bottomRight, y + height, bottomRight);
  }
  context.lineTo(x + bottomLeft, y + height);
  if (bottomLeft > 0) {
    context.arcTo(x, y + height, x, y + height - bottomLeft, bottomLeft);
  }
  context.lineTo(x, y + topLeft);
  if (topLeft > 0) {
    context.arcTo(x, y, x + topLeft, y, topLeft);
  }
  context.closePath();
}

function resolveLevelOwnerBlock(level) {
  return level?.exitBlock ?? level?.blocksWithThisAsTheirSubLevel?.[0] ?? null;
}

/**
 * @param {number} value
 * @param {number} pixelStep
 * @returns {number}
 */
function snapDownToPixelGrid(value, pixelStep) {
  if (!Number.isFinite(value) || !Number.isFinite(pixelStep) || pixelStep <= 0) {
    return value;
  }
  return Math.floor((value + 1e-8) / pixelStep) * pixelStep;
}

/**
 * @param {number} value
 * @param {number} pixelStep
 * @returns {number}
 */
function snapToPixelGrid(value, pixelStep) {
  if (!Number.isFinite(value) || !Number.isFinite(pixelStep) || pixelStep <= 0) {
    return value;
  }
  return Math.round(value / pixelStep) * pixelStep;
}

/**
 * Snap a rectangle outward to pixel boundaries so adjacent rects never leave
 * a sub-pixel gap. Mirrors C#'s SetDrawRect int cast.
 *
 * @param {number} x
 * @param {number} y
 * @param {number} width
 * @param {number} height
 * @param {number} [pixelStep]
 * @returns {{ x: number, y: number, width: number, height: number }}
 */
export function pixelOutsetRect(x, y, width, height, pixelStep = 1) {
  if (!Number.isFinite(pixelStep) || pixelStep <= 0) {
    return { x, y, width, height };
  }
  const left = Math.floor(x / pixelStep) * pixelStep;
  const top = Math.floor(y / pixelStep) * pixelStep;
  const right = Math.ceil((x + width) / pixelStep) * pixelStep;
  const bottom = Math.ceil((y + height) / pixelStep) * pixelStep;
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top
  };
}

/**
 * Fit a level into an available rectangle while keeping square cells.
 *
 * @param {{ width: number, height: number }} level
 * @param {number} availableX
 * @param {number} availableY
 * @param {number} availableWidth
 * @param {number} availableHeight
 * @param {number} [margin]
 * @param {number} [minCellSize]
 * @param {number} [pixelStep]
 * @returns {{ originX: number, originY: number, cellSize: number, drawWidth: number, drawHeight: number }}
 */
export function computeLevelViewport(level, availableX, availableY, availableWidth, availableHeight, margin = 0, minCellSize = 4, pixelStep = 1) {
  const usableWidth = Math.max(1, availableWidth - margin * 2);
  const usableHeight = Math.max(1, availableHeight - margin * 2);
  const rawCellSize = Math.max(minCellSize, Math.min(usableWidth / level.width, usableHeight / level.height));
  const snappedCellSize = snapDownToPixelGrid(rawCellSize, pixelStep);
  const cellSize = Math.max(minCellSize, snappedCellSize || rawCellSize);
  const drawWidth = level.width * cellSize;
  const drawHeight = level.height * cellSize;
  return {
    originX: snapToPixelGrid(availableX + (availableWidth - drawWidth) / 2, pixelStep),
    originY: snapToPixelGrid(availableY + (availableHeight - drawHeight) / 2, pixelStep),
    cellSize,
    drawWidth,
    drawHeight
  };
}

/**
 * @param {any} state
 * @returns {number}
 */
function computeLevelsUp(state) {
  const levelName = state?.currentLevelName ?? "";
  if (levelName === "1by1_stack") {
    return 10;
  }
  if (levelName === "rescue" || levelName === "zoom_out_anim" || levelName === "zoom_in_anim") {
    return 4;
  }
  return 3;
}

/**
 * @param {any} level
 * @param {number} x
 * @param {boolean} flipH
 * @returns {number}
 */
function resolveDrawCellX(level, x, flipH) {
  return flipH ? level.width - 1 - x : x;
}

/**
 * @param {boolean} parentFlipH
 * @param {any} block
 * @returns {boolean}
 */
function resolveBlockTicketFlipH(parentFlipH, block) {
  return block?.kind === "wall" ? Boolean(parentFlipH) : Boolean(parentFlipH) !== Boolean(block?.flipH);
}

/**
 * @param {boolean} parentFlipH
 * @param {any} block
 * @returns {boolean}
 */
function resolvePhantomTicketFlipH(parentFlipH, block) {
  if (!block?.subLevel) {
    return Boolean(parentFlipH);
  }
  return Boolean(parentFlipH) !== (Boolean(block.flipH) !== Boolean(block.fadeFlipH));
}

/**
 * @param {any | null} exitBlock
 * @param {any} drawLevel
 * @param {Set<any>} seenExitBlocks
 * @returns {boolean}
 */
function shouldGoOutOneLevel(exitBlock, drawLevel, seenExitBlocks) {
  if (!exitBlock?.outerLevel) {
    return false;
  }
  if (exitBlock.subLevel === drawLevel && exitBlock.outerLevel === drawLevel) {
    return false;
  }
  const key = exitBlock.id ?? exitBlock;
  if (seenExitBlocks.has(key)) {
    return false;
  }
  seenExitBlocks.add(key);
  return true;
}

/**
 * C# focus branch guard:
 *   World.AnyBlockMoving && CameraMovedThisTurn && !Prefs.InstantZoom
 *
 * JS does not carry Draw.CameraMovedThisTurn as renderer state, so we infer it
 * from the turn-level cameraProjection when present. A caller may also attach
 * turn.cameraMovedThisTurn for exactness.
 *
 * @param {{ turn?: any } | null | undefined} animation
 * @returns {boolean}
 */
function hasTurnCameraProjection(animation) {
  const projection = animation?.turn?.cameraProjection;
  if (!projection) {
    return Boolean(animation?.turn?.cameraMovedThisTurn);
  }
  return (
    Math.abs(projection.dx ?? 0) > 0.0001 ||
    Math.abs(projection.dy ?? 0) > 0.0001 ||
    Math.abs((projection.xscale ?? 1) - 1) > 0.0001 ||
    Math.abs((projection.yscale ?? 1) - 1) > 0.0001 ||
    Boolean(animation?.turn?.cameraMovedThisTurn)
  );
}

/**
 * Mirrors C#'s special focus case for camera-changing enter transitions:
 *
 *   World.AnyBlockMoving && CameraMovedThisTurn && !Prefs.InstantZoom
 *   && block.justEnteredArray != null
 *   && block.justEnteredArray[0].SubLevel == block.OuterLevel
 *   && block.justEnteredArray[0] != block.justEnteredArray[0].SubLevel.GetExitBlock()
 *
 * @param {any} state
 * @param {{ turn?: any, progress?: number, direction?: "forward" | "reverse" } | null | undefined} animation
 * @returns {boolean}
 */
function shouldUseEnterFocusChain(state, animation) {
  if (!animation || animation.direction === "reverse") {
    return false;
  }
  if (state?.prefs?.instantZoom) {
    return false;
  }
  if (!hasTurnCameraProjection(animation)) {
    return false;
  }

  const player = state?.focusBlock ?? state?.playerBlocks?.[0] ?? null;
  const playerLevel = player?.outerLevel ?? null;
  const entered = player?.justEnteredArray?.[0] ?? null;

  return Boolean(
    playerLevel &&
      entered?.subLevel === playerLevel &&
      entered !== getExitBlock(entered.subLevel)
  );
}

/**
 * During the first half of that C# enter-camera transition, outward traversal
 * follows justEnteredArray[k + 1] when it is the block whose sublevel is the
 * outer level currently being expanded. This keeps the containing world aligned
 * with the same chain used by the focus block, avoiding a late snap.
 *
 * @param {any} state
 * @param {{ turn?: any, progress?: number, direction?: "forward" | "reverse" } | null | undefined} animation
 * @param {number} chainIndex
 * @param {any} outerLevel
 * @returns {any | null}
 */
function resolveCSharpOutwardBlock(state, animation, stepIndex, outerLevel, outwardBlocks) {
  const progress = clamp(animation?.progress ?? 1, 0, 1);
  const firstHalf = animation?.direction !== "reverse" && progress < 0.5;

  // C# Draw.cs outward traversal first checks every block already used on the
  // outward path:
  //
  //   for (int l = 0; l < list2.Count; l++) {
  //     Block[] justEnteredArray = list2[l].justEnteredArray;
  //     if (justEnteredArray != null &&
  //         justEnteredArray.Length > k - l &&
  //         justEnteredArray[k - l].SubLevel == outerLevel &&
  //         justEnteredArray[k - l] != justEnteredArray[k - l].SubLevel.GetExitBlock()) {
  //       block3 = ((!flag) ? outerLevel.GetExitBlock() : justEnteredArray[k - l]);
  //       flag4 = true;
  //     }
  //   }
  //
  // The previous JS approximation only checked player.justEnteredArray[k + 1],
  // which misses the list2[l].justEnteredArray[k-l] branch and causes the
  // outward reference block to jump at the half-transition.
  for (let l = 0; l < outwardBlocks.length; l += 1) {
    const chain = outwardBlocks[l]?.justEnteredArray;
    const candidate = chain?.[stepIndex - l] ?? null;
    if (candidate?.subLevel === outerLevel && candidate !== getExitBlock(candidate.subLevel)) {
      return {
        block: firstHalf ? candidate : getExitBlock(outerLevel),
        backingBlock: candidate,
        source: `path:${l}:${stepIndex - l}`
      };
    }
  }

  // C# fallback branch then checks the original player block's
  // justEnteredArray[k + 1], but only under the camera-moving enter condition.
  if (shouldUseEnterFocusChain(state, animation)) {
    const player = state?.focusBlock ?? state?.playerBlocks?.[0] ?? null;
    const candidate = player?.justEnteredArray?.[stepIndex + 1] ?? null;
    if (candidate?.subLevel === outerLevel && candidate !== getExitBlock(candidate.subLevel)) {
      return {
        block: firstHalf ? candidate : getExitBlock(outerLevel),
        backingBlock: candidate,
        source: `player:${stepIndex + 1}`
      };
    }
  }

  return {
    block: getExitBlock(outerLevel),
    backingBlock: null,
    source: "exit"
  };
}

/**
 * @param {any} state
 * @param {{ turn?: any, progress?: number, direction?: "forward" | "reverse" } | null | undefined} animation
 * @returns {any | null}
 */
function resolveRenderFocusBlock(state, animation) {
  const player = state?.focusBlock ?? state?.playerBlocks?.[0] ?? null;
  const playerLevel = player?.outerLevel ?? null;
  if (!playerLevel) {
    return null;
  }

  const playerLevelExit = getExitBlock(playerLevel);
  if (shouldUseEnterFocusChain(state, animation)) {
    const progress = clamp(animation?.progress ?? 1, 0, 1);
    if (progress < 0.5) {
      const entered = player.justEnteredArray?.[0] ?? null;
      if (entered?.subLevel === playerLevel && entered !== getExitBlock(entered.subLevel)) {
        return entered;
      }
    }
  }

  return playerLevelExit ?? resolveLevelOwnerBlock(playerLevel);
}

/**
 * @param {any} focusBlock
 * @param {number} width
 * @param {number} height
 * @param {{ turn?: any, progress?: number, direction?: "forward" | "reverse" } | null | undefined} animation
 * @param {boolean} cameraFlipH
 * @returns {{ x: number, y: number, w: number, h: number }}
 */
function computeFocusBlockViewport(focusBlock, width, height, animation, cameraFlipH) {
  const baseSize = Math.min(width, height) * FOCUS_FRACT_NORMAL;
  const focusZoom = focusBlock?.subLevel?.camZoomFactor ?? 1;
  let xScale = focusZoom;
  let yScale = focusZoom;
  let offsetX = 0;
  let offsetY = 0;
  const rawProjection = animation?.turn?.cameraProjection ?? (
    Number.isFinite(animation?.turn?.camX) &&
    Number.isFinite(animation?.turn?.camY) &&
    Number.isFinite(animation?.turn?.camXS) &&
    Number.isFinite(animation?.turn?.camYS)
      ? { dx: animation.turn.camX, dy: animation.turn.camY, xscale: animation.turn.camXS, yscale: animation.turn.camYS }
      : null
  );
  const projection = animation?.direction !== "reverse" ? rawProjection : null;

  if (
    projection &&
    Number.isFinite(projection.dx) &&
    Number.isFinite(projection.dy) &&
    Number.isFinite(projection.xscale) &&
    Number.isFinite(projection.yscale) &&
    projection.xscale !== 0 &&
    projection.yscale !== 0 &&
    focusZoom !== 0
  ) {
    const progress = clamp(animation?.progress ?? 1, 0, 1);
    xScale = 1 / lerp(1 / projection.xscale, 1 / focusZoom, progress);
    yScale = 1 / lerp(1 / projection.yscale, 1 / focusZoom, progress);
    offsetX = lerp(projection.dx, 0, progress);
    offsetY = lerp(projection.dy, 0, progress);
    if (cameraFlipH) {
      offsetX *= -1;
    }
  }

  const w = baseSize * xScale;
  const h = baseSize * yScale;
  return {
    x: width / 2 + offsetX * w,
    y: height / 2 + offsetY * h,
    w,
    h
  };
}

/**
 * Self-referential enters still draw the containing level. The camera correction
 * only pans that view enough to keep the player/current endpoint on screen.
 *
 * @param {any} state
 * @param {any} focusBlock
 * @param {{ x: number, y: number, w: number, h: number }} viewport
 * @param {number} width
 * @param {number} height
 * @param {boolean} cameraFlipH
 */
function adjustSelfReferenceEnterViewport(state, focusBlock, viewport, width, height, cameraFlipH) {
  const player = state?.focusBlock ?? state?.playerBlocks?.[0] ?? null;
  const playerLevel = player?.outerLevel ?? null;
  const entered = player?.justEnteredArray?.[0] ?? null;
  if (!playerLevel || !entered || entered !== focusBlock || entered !== getExitBlock(playerLevel) || entered.subLevel !== playerLevel) {
    return;
  }
  const cellSize = Math.max(0.5, Math.min(viewport.w / playerLevel.width, viewport.h / playerLevel.height));
  const originX = viewport.x - (playerLevel.width * cellSize) / 2;
  const originY = viewport.y - (playerLevel.height * cellSize) / 2;
  const playerX = originX + resolveDrawCellX(playerLevel, player.xpos, cameraFlipH) * cellSize + cellSize / 2;
  const playerY = originY + player.ypos * cellSize + cellSize / 2;
  const margin = Math.max(24, Math.min(width, height) * 0.12);
  let shiftX = 0;
  let shiftY = 0;
  if (playerX < margin) {
    shiftX = margin - playerX;
  } else if (playerX > width - margin) {
    shiftX = width - margin - playerX;
  }
  if (playerY < margin) {
    shiftY = margin - playerY;
  } else if (playerY > height - margin) {
    shiftY = height - margin - playerY;
  }
  viewport.x += shiftX;
  viewport.y += shiftY;
}

/**
 * @param {any} block
 * @param {{ turn?: any, progress?: number, direction?: "forward" | "reverse" } | null | undefined} animation
 * @returns {{ x: number, y: number } | null}
 */
export function resolveAnimatedDrawCell(block, animation) {
  const move = animation?.turn?.moves?.find?.((entry) => entry.block?.id === block.id) ?? null;
  if (!move || move.fromLevel !== move.toLevel || move.toLevel !== block.outerLevel) {
    return null;
  }
  const progress = animation?.progress ?? 1;
  const reverse = animation?.direction === "reverse";
  const fromX = reverse ? move.toX : move.fromX;
  const fromY = reverse ? move.toY : move.fromY;
  const toX = reverse ? move.fromX : move.toX;
  const toY = reverse ? move.fromY : move.toY;
  return {
    x: fromX + (toX - fromX) * progress,
    y: fromY + (toY - fromY) * progress
  };
}

/**
 * Prefer the projection captured by the movement engine. Falling back to the
 * trail keeps synthetic render tests and older saved turns readable.
 *
 * @param {any} move
 * @returns {{ xscale: number, yscale: number, dx: number, dy: number } | null}
 */
export function resolveMoveProjection(move) {
  if (
    Number.isFinite(move?.animXOffset) &&
    Number.isFinite(move?.animYOffset) &&
    Number.isFinite(move?.animXScale) &&
    Number.isFinite(move?.animYScale)
  ) {
    return {
      dx: move.animXOffset,
      dy: move.animYOffset,
      xscale: move.animXScale,
      yscale: move.animYScale
    };
  }
  return computeProjectionFromTrail(move?.trail);
}

/**
 * @param {any} move
 * @returns {{ offsetX: number, offsetY: number, scaleX: number, scaleY: number } | null}
 */
export function resolveMoveDrawStart(move) {
  if (
    Number.isFinite(move?.drawXOffsetStart) &&
    Number.isFinite(move?.drawYOffsetStart) &&
    Number.isFinite(move?.drawXScaleStart) &&
    Number.isFinite(move?.drawYScaleStart)
  ) {
    return {
      offsetX: move.drawXOffsetStart,
      offsetY: move.drawYOffsetStart,
      scaleX: move.drawXScaleStart,
      scaleY: move.drawYScaleStart
    };
  }
  const projection = resolveMoveProjection(move);
  return projection
    ? {
        offsetX: projection.dx,
        offsetY: projection.dy,
        scaleX: projection.xscale,
        scaleY: projection.yscale
      }
    : null;
}

/**
 * @param {{ turn?: any } | null | undefined} animation
 * @param {any} block
 * @param {Map<number, any> | null} [moveByBlockId]
 * @returns {any | null}
 */
function getAnimationMove(animation, block, moveByBlockId = null) {
  if (!block) {
    return null;
  }
  if (moveByBlockId) {
    return moveByBlockId.get(block.id) ?? null;
  }
  return animation?.turn?.moves?.find?.((entry) => entry.block?.id === block.id) ?? null;
}

/**
 * @param {{ turn?: any, _moveByBlockId?: Map<number, any>, _renderPhantomsByLevel?: Map<number, Array<any>> } | null | undefined} animation
 */
function prepareAnimationLookups(animation) {
  if (!animation?.turn) {
    return;
  }
  if (!animation._moveByBlockId) {
    const moveByBlockId = new Map();
    for (const move of animation.turn.moves ?? []) {
      if (move?.block?.id != null) {
        moveByBlockId.set(move.block.id, move);
      }
    }
    animation._moveByBlockId = moveByBlockId;
  }
  if (!animation._animatedLevelIds) {
    const ids = new Set();
    for (const move of animation.turn.moves ?? []) {
      if (move.fromLevel?.id != null) ids.add(move.fromLevel.id);
      if (move.toLevel?.id != null) ids.add(move.toLevel.id);
    }
    animation._animatedLevelIds = ids;
  }
  if (!animation._renderPhantomsByLevel) {
    const phantomsByLevel = new Map();
    for (const phantom of animation.turn.renderPhantoms ?? []) {
      const levelId = phantom?.outerLevel?.id;
      if (levelId == null) {
        continue;
      }
      if (!phantomsByLevel.has(levelId)) {
        phantomsByLevel.set(levelId, []);
      }
      phantomsByLevel.get(levelId).push(phantom);
    }
    animation._renderPhantomsByLevel = phantomsByLevel;
  }
}


/**
 * C# Draw.ComputeBorderThickness: round the clamped min dimension and cap it
 * relative to screen size so large blocks do not cast oversized shadows.
 *
 * @param {number} width
 * @param {number} height
 * @param {number} screenWidth
 * @param {number} screenHeight
 * @returns {number}
 */
export function computeBorderThickness(width, height, screenWidth = width, screenHeight = height) {
  const value = Math.min(width, height) / 30;
  const cap = Math.max(1, Math.min(screenWidth, screenHeight) * 0.00508);
  return Math.max(Math.round(clamp(value, 1, cap)), 1);
}

/**
 * @param {number} width
 * @param {number} height
 * @param {any} block
 * @param {number} staticWidth
 * @param {number} staticHeight
 * @param {number} screenWidth
 * @param {number} screenHeight
 * @returns {number}
 */
export function computeBorderThicknessBlock(width, height, block, staticWidth, staticHeight, screenWidth = width, screenHeight = height) {
  if (block?.moving && block?.animKind !== "ENTER_EXIT" && block?.animKind !== "JUMP_IN" && block?.animKind !== "JUMP_OUT") {
    return computeBorderThickness(staticWidth, staticHeight, screenWidth, screenHeight);
  }
  return computeBorderThickness(width, height, screenWidth, screenHeight);
}

/**
 * @param {number} width
 * @param {number} height
 * @param {any} block
 * @param {boolean} flipH
 * @param {number} staticWidth
 * @param {number} staticHeight
 * @param {number} screenWidth
 * @param {number} screenHeight
 * @returns {{ offsetX: number, offsetY: number }}
 */
export function computeBlockShadowOffset(width, height, block, flipH, staticWidth = width, staticHeight = height, screenWidth = width, screenHeight = height) {
  let offset = computeBorderThicknessBlock(width, height, block, staticWidth, staticHeight, screenWidth, screenHeight) * 2;
  if (width < 13 && height < 13) {
    offset = 1;
  }
  return {
    offsetX: flipH ? -offset : offset,
    offsetY: offset
  };
}

/**
 * Mirrors the draw-side branch that avoids drawing a child as if it were
 * moving in the currently rendered parent copy.
 *
 * @param {any | null | undefined} parentBlock
 * @param {any} childBlock
 * @param {{ turn?: any } | null | undefined} animation
 * @param {Array<any>} [parents]
 * @param {string} [drawStyle]
 * @param {number} [depth]
 * @returns {boolean}
 */
export function shouldSimpleSlide(parentBlock, childBlock, animation, parents = [], drawStyle = "normal", depth = 0) {
  if (!parentBlock || parentBlock.subLevel?.infZone || !Array.isArray(childBlock?.justEnteredArray)) {
    return false;
  }
  const move = getAnimationMove(animation, childBlock, animation?._moveByBlockId ?? null);
  const animKind = move?.animKind ?? move?.animType ?? (move?.trail?.some?.((step) => step.moveType === "Enter" || step.moveType === "Exit") ? "ENTER_EXIT" : "NORMAL");
  if (!move || (animKind !== "ENTER_EXIT" && animKind !== "NORMAL")) {
    return false;
  }
  if (childBlock.justEnteredArray[0] !== parentBlock) {
    return true;
  }
  if (drawStyle === "grid" && parents.length === 0) {
    return true;
  }
  if (parents.length === 0) {
    return false;
  }
  for (let index = 1; index < childBlock.justEnteredArray.length; index += 1) {
    if (index > parents.length) {
      return true;
    }
    if (childBlock.justEnteredArray[index] !== parents[index - 1]) {
      return true;
    }
  }
  return drawStyle === "grid" && depth < childBlock.justEnteredArray.length;
}

/**
 * @param {any} block
 * @param {{ turn?: any, progress?: number, direction?: "forward" | "reverse" } | null | undefined} animation
 * @param {any | null} [parentBlock]
 * @param {boolean} [simpleSlide]
 * @returns {{ offsetX: number, offsetY: number, scaleX: number, scaleY: number } | null}
 */
export function resolveAnimatedDrawTransform(block, animation, parentBlock = null, simpleSlide = false) {
  const move = getAnimationMove(animation, block, animation?._moveByBlockId ?? null);
  if (!move) {
    return null;
  }
  const progress = clamp(animation?.progress ?? 1, 0, 1);
  const reverse = animation?.direction === "reverse";
  const animKind = move?.animKind ?? move?.animType ?? null;
  const hasEnterExitTrail =
    animKind === "ENTER_EXIT" ||
    move.trail?.some?.((step) => step.moveType === "Enter" || step.moveType === "Exit");

  if (!hasEnterExitTrail && move.fromLevel === move.toLevel && move.toLevel === block.outerLevel) {
    const offsetX = reverse
      ? (move.toX - move.fromX) * (1 - progress)
      : (move.fromX - move.toX) * (1 - progress);
    const offsetY = reverse
      ? (move.toY - move.fromY) * (1 - progress)
      : (move.fromY - move.toY) * (1 - progress);
    return { offsetX: cleanSignedZero(offsetX), offsetY: cleanSignedZero(offsetY), scaleX: 1, scaleY: 1 };
  }

  if (reverse || !hasEnterExitTrail) {
    return null;
  }

  const drawStart = resolveMoveDrawStart(move);
  if (!drawStart) {
    return null;
  }

  if (simpleSlide) {
    return {
      offsetX: cleanSignedZero(drawStart.offsetX * (1 - progress)),
      offsetY: cleanSignedZero(drawStart.offsetY * (1 - progress)),
      scaleX: 1,
      scaleY: 1
    };
  }

  let startOffsetX = drawStart.offsetX;
  let startOffsetY = drawStart.offsetY;
  let startScaleX = drawStart.scaleX;
  let startScaleY = drawStart.scaleY;

  // C# Block.UpdateAnimation ENTER_EXIT special case:
  // if this block just entered a block that is itself currently ENTER_EXIT-moving,
  // the child transform is relative to the parent's current DrawXScale/YScale.
  if (parentBlock && block.justEnteredArray?.[0] === parentBlock && hasEnterExitTrail) {
    const parentMove = getAnimationMove(animation, parentBlock, animation?._moveByBlockId ?? null);
    const parentStart = parentMove ? resolveMoveDrawStart(parentMove) : null;
    const parentAnimKind = parentMove?.animKind ?? parentMove?.animType ?? null;
    const parentEnterExit =
      parentAnimKind === "ENTER_EXIT" ||
      parentMove?.trail?.some?.((step) => step.moveType === "Enter" || step.moveType === "Exit");
    if (parentStart && parentEnterExit) {
      const parentScaleX = lerp(parentStart.scaleX, 1, progress);
      const parentScaleY = lerp(parentStart.scaleY, 1, progress);
      if (Math.abs(parentScaleX) > 0.000001) {
        startScaleX /= parentScaleX;
      }
      if (Math.abs(parentScaleY) > 0.000001) {
        startScaleY /= parentScaleY;
      }
      if (startOffsetX !== 0 && parentBlock.subLevel?.width) {
        startOffsetX += Math.sign(startOffsetX) * (-parentBlock.subLevel.width / 2 + startScaleX / 2);
      } else if (startOffsetY !== 0 && parentBlock.subLevel?.height) {
        startOffsetY += Math.sign(startOffsetY) * (-parentBlock.subLevel.height / 2 + startScaleY / 2);
      }
    }
  }

  return {
    offsetX: cleanSignedZero(startOffsetX * (1 - progress)),
    offsetY: cleanSignedZero(startOffsetY * (1 - progress)),
    scaleX: lerp(startScaleX, 1, progress),
    scaleY: lerp(startScaleY, 1, progress)
  };
}

/**
 * @param {{ turn?: any } | null | undefined} animation
 * @param {any} level
 * @returns {Array<any>}
 */
export function getRenderPhantomsForLevel(animation, level) {
  if (animation?._renderPhantomsByLevel) {
    return animation._renderPhantomsByLevel.get(level?.id) ?? [];
  }
  return (animation?.turn?.renderPhantoms ?? []).filter((phantom) => phantom.outerLevel === level);
}

/**
 * @param {any} block
 * @param {any} animation
 * @param {any | null} parentBlock
 * @param {boolean} simpleSlide
 * @returns {boolean}
 */
function isBlockAnimatedForRender(block, animation, parentBlock = null, simpleSlide = false) {
  if (!animation || !block) {
    return false;
  }
  const transform = resolveAnimatedDrawTransform(block, animation, parentBlock, simpleSlide);
  return Boolean(
    transform &&
      (Math.abs(transform.offsetX) > 0.0001 ||
        Math.abs(transform.offsetY) > 0.0001 ||
        Math.abs(transform.scaleX - 1) > 0.0001 ||
        Math.abs(transform.scaleY - 1) > 0.0001)
  );
}

/**
 * @param {any} phantom
 * @param {{ progress?: number, direction?: "forward" | "reverse" } | null | undefined} animation
 * @returns {{ offsetX: number, offsetY: number, scaleX: number, scaleY: number }}
 */
export function resolveRenderPhantomTransform(phantom, animation) {
  const rawProgress = clamp(animation?.progress ?? 1, 0, 1);
  const progress = animation?.direction === "reverse" ? 1 - rawProgress : rawProgress;
  return {
    offsetX: cleanSignedZero(lerp(phantom.xFrom ?? 0, phantom.xTo ?? 0, progress)),
    offsetY: cleanSignedZero(lerp(phantom.yFrom ?? 0, phantom.yTo ?? 0, progress)),
    scaleX: lerp(phantom.xScaleFrom ?? 1, phantom.xScaleTo ?? 1, progress),
    scaleY: lerp(phantom.yScaleFrom ?? 1, phantom.yScaleTo ?? 1, progress)
  };
}

/**
 * @param {any} block
 * @param {number} x
 * @param {number} y
 * @param {number} size
 * @param {{ turn?: any, progress?: number, direction?: "forward" | "reverse" } | null | undefined} animation
 * @param {any | null} parentBlock
 * @param {boolean} simpleSlide
 * @param {boolean} [mirrorOffsetX]
 * @returns {{ drawX: number, drawY: number, width: number, height: number }}
 */
function resolveBlockDrawRect(block, x, y, size, animation, parentBlock = null, simpleSlide = false, mirrorOffsetX = false) {
  const animatedTransform = resolveAnimatedDrawTransform(block, animation, parentBlock, simpleSlide);
  const scaleX = animatedTransform?.scaleX ?? 1;
  const scaleY = animatedTransform?.scaleY ?? 1;
  const width = size * scaleX;
  const height = size * scaleY;
  const offsetX = (animatedTransform?.offsetX ?? 0) * (mirrorOffsetX ? -1 : 1);
  const centerX = x + size / 2 + offsetX * size;
  const centerY = y + size / 2 + (animatedTransform?.offsetY ?? 0) * size;
  return {
    drawX: centerX - width / 2,
    drawY: centerY - height / 2,
    width,
    height
  };
}

/**
 * @param {any} block
 * @param {number} depth
 * @param {Set<number> | null | undefined} path
 * @param {number} [previewSize]
 * @param {number} [maxDepth]
 * @returns {boolean}
 */
export function shouldDrawNestedLevel(
  block,
  depth,
  path,
  previewSize = Number.POSITIVE_INFINITY,
  maxDepth = MAX_SUBLEVEL_RENDER_DEPTH
) {
  void path;
  if (!block?.subLevel) {
    return false;
  }
  if (depth >= maxDepth) {
    return false;
  }
  if (previewSize < MIN_FULL_NESTED_SIZE) {
    return false;
  }
  // C# only uses depth limit for cycle protection — no visited set.
  // Self-reference stays visible; repeated work is handled by the nested cache.
  return true;
}

/**
 * Blocks whose sublevel is just a filled-wall placeholder should still render
 * as solid colored squares instead of exposing an inner window.
 *
 * @param {any} block
 * @returns {boolean}
 */
export function shouldRenderNestedInterior(block) {
  return Boolean(block?.subLevel && !block.subLevel.filledWithWalls);
}

/**
 * @param {any} state
 * @returns {string}
 */
function buildNestedRenderStateKey(state) {
  return [
    state?.currentLevelName ?? "",
    state?.drawStyle ?? "",
    state?.prefs?.grid ? 1 : 0
  ].join(";");
}

export class CanvasRenderer {
  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas) {
    this.canvas = canvas;
    this.context = canvas.getContext("2d");
    if (!this.context) {
      throw new Error("Canvas2D unavailable");
    }
    this.pixelRatio = 1;
    this.textures = new Map();
    this.loadingTextures = new Set();
    this.textureLoadStarted = false;
    this.tintCanvas = null;
    this.tintContext = null;
    this.modulatedTextureCache = new Map();
    this.modulatedTextureCacheAssetVersion = -1;
    this.wallBigQuads = null;
    this.wallBigDataLoadStarted = false;
    this.cameraFlipH = false;
    this.assetVersion = 0;
    this._compactPreviewCount = 0;
    this._renderStats = null;
    this.lastRenderStats = null;
    this.nestedLevelCache = new Map();
    this.nestedLevelCacheStateKey = "";
    this.nestedLevelCacheAssetVersion = -1;
    this.nestedLevelCachePixelRatio = 0;
    this.nestedLevelCacheInProgress = new Set();
    this.nestedLevelCacheTotalPixels = 0;
    this.nestedLevelCacheLastFullKeyByBaseKey = new Map();
    this._lastHadAnimation = false;
    this.debugFrames = [];
    this.debugStartTime = typeof performance !== "undefined" ? performance.now() : Date.now();
    this.debugDroppedFrames = 0;
    this.installDebugHooks();
    this.beginTextureLoad();
  }

  beginTextureLoad() {
    if (this.textureLoadStarted || typeof fetch === "undefined") {
      return;
    }
    this.textureLoadStarted = true;
    this._loadSpriteSheet();
    this.ensureWallBigData();
  }

  async _loadSpriteSheet() {
    try {
      const [manifestRes, sheetImg] = await Promise.all([
        fetch("/game-data/textures-manifest.json").then((r) => r.ok ? r.json() : null),
        new Promise((resolve) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => resolve(null);
          img.src = "/game-data/textures-sheet.png";
        })
      ]);
      this._spriteSheet = sheetImg;
      this._spriteManifest = manifestRes;
      // Pre-populate textures Map with lazy extraction markers
      if (manifestRes) {
        for (const name of Object.keys(manifestRes)) {
          this.textures.set(name, null);
        }
      }
      this.assetVersion += 1;
    } catch {
      this._spriteSheet = null;
      this._spriteManifest = null;
      this.assetVersion += 1;
    }
  }

  _extractSprite(filename) {
    const sheet = this._spriteSheet;
    const manifest = this._spriteManifest;
    if (!sheet || !manifest) return null;
    const rect = manifest[filename];
    if (!rect) return null;
    const off = document.createElement("canvas");
    off.width = rect.w;
    off.height = rect.h;
    const ctx = off.getContext("2d");
    ctx.drawImage(sheet, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
    return off;
  }

  ensureWallBigData() {
    if (this.wallBigQuads || this.wallBigDataLoadStarted || typeof fetch === "undefined") {
      return;
    }
    this.wallBigDataLoadStarted = true;
    fetch(wallBigDataUrl())
      .then((response) => (response.ok ? response.text() : ""))
      .then((text) => {
        if (text) {
          this.wallBigQuads = parseWallBigData(text);
        }
        this.assetVersion += 1;
      })
      .catch(() => {
        this.wallBigQuads = null;
        this.assetVersion += 1;
      });
  }

  /**
   * @param {string} filename
   * @returns {HTMLImageElement | null}
   */
  ensureTexture(filename) {
    const cached = this.textures.get(filename);
    if (cached !== undefined && cached !== null) {
      return cached;
    }
    // Check if filename exists in manifest but hasn't been extracted yet
    if (this._spriteManifest?.[filename]) {
      const img = this._extractSprite(filename);
      if (img) {
        this.textures.set(filename, img);
        return img;
      }
    }
    // Fallback: if _0 variant not in manifest, try base name (e.g. top_0.png → top.png)
    if (filename.endsWith("_0.png") && this._spriteManifest) {
      const baseName = filename.replace(/_0\.png$/, ".png");
      if (this._spriteManifest[baseName]) {
        const img = this._extractSprite(baseName);
        if (img) {
          this.textures.set(filename, img);
          return img;
        }
      }
    }
    if (this.loadingTextures.has(filename) || typeof Image === "undefined") {
      return cached ?? null;
    }
    // Fallback: individual file load for any texture not in the sheet
    this.loadingTextures.add(filename);
    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      this.loadingTextures.delete(filename);
      this.textures.set(filename, image);
    };
    image.onerror = () => {
      this.loadingTextures.delete(filename);
    };
    image.src = textureUrl(filename);
    return null;
  }

  /**
   * @param {keyof typeof TEXTURE_FILES} key
   * @returns {HTMLImageElement | null}
   */
  getTexture(key) {
    return this.ensureTexture(TEXTURE_FILES[key]);
  }

  /**
   * @param {string} filename
   * @returns {HTMLImageElement | null}
   */
  getTextureFile(filename) {
    return this.ensureTexture(filename);
  }

  /**
   * @param {keyof typeof TEXTURE_FILES} key
   * @param {number} x
   * @param {number} y
   * @param {number} width
   * @param {number} height
   * @param {number} [alpha]
   * @returns {boolean}
   */
  drawTexture(key, x, y, width, height, alpha = 1) {
    const texture = this.getTexture(key);
    if (!texture) {
      return false;
    }
    const context = this.context;
    const prevAlpha = context.globalAlpha;
    const prevSmoothing = context.imageSmoothingEnabled;
    context.globalAlpha = clamp(alpha, 0, 1);
    context.imageSmoothingEnabled = true;
    context.drawImage(texture, x, y, width, height);
    context.globalAlpha = prevAlpha;
    context.imageSmoothingEnabled = prevSmoothing;
    return true;
  }

  /**
   * @param {keyof typeof TEXTURE_FILES} key
   * @param {number} x
   * @param {number} y
   * @param {number} width
   * @param {number} height
   * @param {string} tintCss
   * @param {number} [alpha]
   * @returns {boolean}
   */
  drawTextureTinted(key, x, y, width, height, tintCss, alpha = 1) {
    const texture = this.getTexture(key);
    if (!texture) {
      return false;
    }
    drawTintedTexture(this, texture, x, y, width, height, tintCss, alpha);
    return true;
  }

  /**
   * @param {string} filename
   * @param {number} x
   * @param {number} y
   * @param {number} width
   * @param {number} height
   * @param {number} [alpha]
   * @returns {boolean}
   */
  drawTextureFile(filename, x, y, width, height, alpha = 1) {
    const texture = this.getTextureFile(filename);
    if (!texture) {
      return false;
    }
    const context = this.context;
    const prevAlpha = context.globalAlpha;
    const prevSmoothing = context.imageSmoothingEnabled;
    context.globalAlpha = clamp(alpha, 0, 1);
    context.imageSmoothingEnabled = true;
    context.drawImage(texture, x, y, width, height);
    context.globalAlpha = prevAlpha;
    context.imageSmoothingEnabled = prevSmoothing;
    return true;
  }

  /**
   * @param {string} filename
   * @param {number} x
   * @param {number} y
   * @param {number} width
   * @param {number} height
   * @param {string} tintCss
   * @param {number} [alpha]
   * @returns {boolean}
   */
  drawTextureFileTinted(filename, x, y, width, height, tintCss, alpha = 1) {
    const texture = this.getTextureFile(filename);
    if (!texture) {
      return false;
    }
    drawTintedTexture(this, texture, x, y, width, height, tintCss, alpha);
    return true;
  }

  /**
   * @param {string} filename
   * @param {number} x
   * @param {number} y
   * @param {number} width
   * @param {number} height
   * @param {{ r: number, g: number, b: number }} tintRgb
   * @param {number} [alpha]
   * @param {boolean} [imageSmoothing]
   * @param {boolean} [flipY]
   * @returns {boolean}
   */
  drawTextureFileModulated(filename, x, y, width, height, tintRgb, alpha = 1, imageSmoothing = true, flipY = false, flipX = false) {
    if (this._renderStats) {
      this._renderStats.wallTextureDraws += 1;
    }
    const texture = this.getTextureFile(filename);
    if (!texture) {
      return false;
    }
    if (drawCachedModulatedTexture(this, filename, texture, x, y, width, height, tintRgb, alpha, imageSmoothing, flipY, flipX)) {
      return true;
    }
    drawModulatedTexture(this, texture, x, y, width, height, tintRgb, alpha, imageSmoothing, flipY, flipX);
    return true;
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const pixelRatio = Math.min(window.devicePixelRatio || 1, MAX_CANVAS_PIXEL_RATIO);
    const width = Math.max(1, Math.floor(rect.width * pixelRatio));
    const height = Math.max(1, Math.floor(rect.height * pixelRatio));
    let changed = false;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      changed = true;
    }
    if (this.pixelRatio !== pixelRatio) {
      changed = true;
    }
    this.pixelRatio = pixelRatio;
    this.context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    return changed;
  }

  /**
   * @returns {number}
   */
  getScreenHeight() {
    return Math.max(1, this.canvas.height / this.pixelRatio);
  }

  /**
   * @param {number} width
   * @param {number} height
   * @returns {number}
   */
  getFractionOfScreen(width, height) {
    return (width + height) / 2 / this.getScreenHeight();
  }

  /**
   * @param {{ r: number, g: number, b: number }} rgb
   * @param {number} [alpha]
   * @returns {string}
   */
  rgbToCss(rgb, alpha = 1) {
    const r = Math.round(clamp(rgb.r, 0, 1) * 255);
    const g = Math.round(clamp(rgb.g, 0, 1) * 255);
    const b = Math.round(clamp(rgb.b, 0, 1) * 255);
    if (alpha >= 1) {
      return `rgb(${r} ${g} ${b})`;
    }
    return `rgba(${r}, ${g}, ${b}, ${clamp(alpha, 0, 1)})`;
  }

  /**
   * @param {{ r: number, g: number, b: number }} rgb
   * @param {number} [alpha]
   * @returns {string}
   */
  linearRgbToCss(rgb, alpha = 1) {
    const r = Math.round(linearToSrgb(rgb.r) * 255);
    const g = Math.round(linearToSrgb(rgb.g) * 255);
    const b = Math.round(linearToSrgb(rgb.b) * 255);
    if (alpha >= 1) {
      return `rgb(${r} ${g} ${b})`;
    }
    return `rgba(${r}, ${g}, ${b}, ${clamp(alpha, 0, 1)})`;
  }

  /**
   * @param {number} h
   * @param {number} s
   * @param {number} v
   * @param {number} [alpha]
   * @returns {string}
   */
  hsvToCssAlpha(h, s, v, alpha = 1) {
    return this.rgbToCss(hsvToRgb(h, s, v), alpha);
  }

  /**
   * @param {any} block
   * @param {number} width
   * @param {number} height
   * @returns {{ hue: number, sat: number, val: number }}
   */
  computeBlockHsv(block, width, height) {
    return computeDrawBlockHsv(block, this.getFractionOfScreen(width, height));
  }

  /**
   * @param {any} block
   * @param {number} width
   * @param {number} height
   * @param {boolean} active
   * @returns {{ hue: number, sat: number, val: number }}
   */
  computeLineHsv(block, width, height, active) {
    return computeDrawLineHsv(block, this.getFractionOfScreen(width, height), active);
  }

  /**
   * @param {any | null} ownerBlock
   * @param {number} width
   * @param {number} height
   * @returns {{ hue: number, sat: number, val: number }}
   */
  computeWallHsv(ownerBlock, width, height) {
    return computeDrawWallHsv(ownerBlock, this.getFractionOfScreen(width, height));
  }

  /**
   * @param {any | null} ownerBlock
   * @param {number} width
   * @param {number} height
   * @returns {{
   *   fill: { hue: number, sat: number, val: number },
   *   line: { hue: number, sat: number, val: number },
   *   wall: { hue: number, sat: number, val: number }
   * }}
   */
  computeScaffoldPalette(ownerBlock, width, height) {
    if (!ownerBlock) {
      return {
        fill: { hue: 0.56, sat: 0.18, val: 0.14 },
        line: { hue: 0.58, sat: 0.15, val: 0.62 },
        wall: { hue: 0.56, sat: 0.12, val: 0.48 }
      };
    }

    const fill = this.computeBlockHsv(ownerBlock, width, height);
    const line = this.computeLineHsv(ownerBlock, width, height, true);
    const wall = this.computeWallHsv(ownerBlock, width, height);
    return {
      fill: {
        hue: fill.hue,
        sat: clamp(fill.sat * 0.9, 0, 1),
        val: clamp(fill.val * 0.85, 0, 1)
      },
      line,
      wall
    };
  }

  /**
   * @param {number} x
   * @param {number} y
   * @param {number} width
   * @param {number} height
   * @param {{ hue: number, sat: number, val: number }} fillHsv
   * @param {{ hue: number, sat: number, val: number }} lineHsv
   * @param {{ addShadow?: boolean, bodyAlpha?: number }} [options]
   */
  drawColorBlockSurface(x, y, width, height, fillHsv, lineHsv, options = {}) {
    const context = this.context;
    const fillRgb = hsvToRgb(fillHsv.hue, fillHsv.sat, fillHsv.val);
    const bodyAlpha = options.bodyAlpha ?? 1;

    if (bodyAlpha >= 1) {
      context.fillStyle = this.linearRgbToCss(fillRgb);
      context.fillRect(x, y, width, height);
      if (width >= 20 && height >= 20) {
        this.drawTexture("blockGradient", x, y, width, height, 0.08);
      }
    } else {
      context.globalAlpha = bodyAlpha;
      context.fillStyle = this.linearRgbToCss(fillRgb);
      context.fillRect(x, y, width, height);
      context.globalAlpha = 1;
      if (width >= 20 && height >= 20) {
        this.drawTexture("blockGradient", x, y, width, height, 0.08 * bodyAlpha);
      }
    }
  }

  /**
   * C# DrawBlock inner frame + DrawBlockBorder perimeter strips.
   * Draws a thin border around a block using its line color (darkened).
   * Infinity blocks get a yellow border instead.
   *
   * @param {any} block
   * @param {number} x
   * @param {number} y
   * @param {number} width
   * @param {number} height
   * @param {number} staticSize
   * @param {{ hue: number, sat: number, val: number }} lineHsv
   * @param {boolean} [flipH]
   */
  drawBlockBorder(block, x, y, width, height, staticSize, lineHsv, flipH = false) {
    const context = this.context;
    const screenWidth = this.canvas?.width && this.pixelRatio ? this.canvas.width / this.pixelRatio : staticSize;
    const screenHeight = this.canvas?.height && this.pixelRatio ? this.canvas.height / this.pixelRatio : staticSize;
    const baseThickness = computeBorderThicknessBlock(width, height, block, staticSize, staticSize, screenWidth, screenHeight);
    if (baseThickness <= 0) {
      return;
    }
    const mask = block.subLevel ? computeLevelWallMask(block.subLevel) : null;
    const isInfinity = shouldDrawInfinityEffect(block) || Boolean(block?.outerLevel?.infZone);

    const thickness = isInfinity ? Math.max(2, Math.round(baseThickness * 1.5)) : baseThickness;

    if (isInfinity) {
      context.fillStyle = this.hsvToCssAlpha(0.15, 1, 1, 0.5);
    } else {
      context.fillStyle = this.hsvToCssAlpha(
        lineHsv.hue,
        clamp(lineHsv.sat * 1.2, 0, 1),
        clamp(lineHsv.val * 0.18, 0, 1),
        0.12
      );
    }

    const leftWall = flipH ? mask?.rightWall : mask?.leftWall;
    const rightWall = flipH ? mask?.leftWall : mask?.rightWall;

    if (!mask || mask.upWall) {
      context.fillRect(x, y, width, thickness);
    }
    if (!mask || mask.downWall) {
      context.fillRect(x, y + height - thickness, width, thickness);
    }
    if (!mask || leftWall) {
      context.fillRect(x, y, thickness, height);
    }
    if (!mask || rightWall) {
      context.fillRect(x + width - thickness, y, thickness, height);
    }
  }

  /**
   * @param {any} block
   * @param {number} x
   * @param {number} y
   * @param {number} width
   * @param {number} height
   * @param {boolean} [flipH]
   * @param {number} [staticWidth]
   * @param {number} [staticHeight]
   */
  drawBlockShadow(block, x, y, width, height, flipH = false, staticWidth = width, staticHeight = height) {
    if (block?.outerLevel?.width === 1 && block.outerLevel?.height === 1) {
      return;
    }
    if (shouldCullWallShadow(block, flipH)) {
      return;
    }
    const context = this.context;
    const screenWidth = this.canvas?.width && this.pixelRatio ? this.canvas.width / this.pixelRatio : staticWidth;
    const screenHeight = this.canvas?.height && this.pixelRatio ? this.canvas.height / this.pixelRatio : staticHeight;
    const { offsetX, offsetY } = computeBlockShadowOffset(width, height, block, flipH, staticWidth, staticHeight, screenWidth, screenHeight);

    if (this._shadowBatchActive) {
      context.fillRect(x + offsetX, y + offsetY, width, height);
    } else {
      context.save();
      context.globalAlpha = 0.15;
      context.fillStyle = "rgb(0 0 0)";
      context.fillRect(x + offsetX, y + offsetY, width, height);
      context.restore();
    }
  }

  beginShadowBatch() {
    this._shadowBatchActive = true;
    const context = this.context;
    context.save();
    context.globalAlpha = 0.15;
    context.fillStyle = "rgb(0 0 0)";
  }

  endShadowBatch() {
    this._shadowBatchActive = false;
    this.context.restore();
  }

  /**
   * @param {any} block
   * @param {number} x
   * @param {number} y
   * @param {number} width
   * @param {number} height
   * @param {number} depth
   * @returns {{ x: number, y: number, width: number, height: number }}
   */
  computeNestedShellWindow(block, x, y, width, height, depth) {
    return { x, y, width, height };
  }

  /**
   * @param {any} block
   * @param {number} x
   * @param {number} y
   * @param {number} width
   * @param {number} height
   * @param {number} depth
   * @returns {{ x: number, y: number, width: number, height: number }}
   */
  drawNestedShell(block, x, y, width, height, depth) {
    const window = this.computeNestedShellWindow(block, x, y, width, height, depth);
    const context = this.context;
    const prevFillStyle = context.fillStyle;
    context.fillStyle = "rgba(0, 0, 0, 0.18)";
    context.fillRect(window.x, window.y, window.width, window.height);
    context.fillStyle = prevFillStyle;
    return window;
  }

  /**
   * @param {any} block
   * @param {number} x
   * @param {number} y
   * @param {number} width
   * @param {number | boolean} [heightOrDrawFace]
   * @param {boolean} [drawFaceArg]
   */
  drawWallBlock(block, x, y, width, heightOrDrawFace = width, drawFaceArg = true, flipH = block.flipH) {
    const context = this.context;
    const height = typeof heightOrDrawFace === "number" ? heightOrDrawFace : width;
    const drawFace = typeof heightOrDrawFace === "boolean" ? heightOrDrawFace : drawFaceArg;
    const ownerBlock = resolveLevelOwnerBlock(block.outerLevel);
    const wallHsv = this.computeWallHsv(ownerBlock, width, height);
    const wallIndex = computeWallTileIndex(block, flipH);
    const tintRgb = hsvToRgb(wallHsv.hue, wallHsv.sat, wallHsv.val);

    if (!this.drawWallTexture(block, wallIndex, x, y, width, height, tintRgb, flipH)) {
      context.fillStyle = this.rgbToCss(tintRgb, 1);
      context.fillRect(x, y, width, height);
    }

    if (drawFace && (block.isPlayer || block.possessable)) {
      this.drawFace(block, x, y, width, height, false);
    }
  }

  /**
   * @param {any} block
   * @param {number} wallIndex
   * @param {number} x
   * @param {number} y
   * @param {number} width
   * @param {number} height
   * @param {{ r: number, g: number, b: number }} tintRgb
   * @returns {boolean}
   */
  drawWallTexture(block, wallIndex, x, y, width, height, tintRgb, flipH = false) {
    if ((width >= 256 || height >= 256) && this.wallBigQuads?.[wallIndex]) {
      const quad = this.wallBigQuads[wallIndex];
      const halfWidth = width / 2;
      const halfHeight = height / 2;
      const drawPiece = (pieceIndex, pieceX, pieceY, pieceWidth, pieceHeight) => {
        const snapped = pixelOutsetRect(pieceX, pieceY, pieceWidth, pieceHeight);
        const baseName = WALL_BIG_TEXTURE_FILES[pieceIndex];
        if (!baseName) {
          return false;
        }
        const filename = flipH ? baseName : baseName.replace(/\.png$/, "_0.png");
        return this.drawTextureFileModulated(filename, snapped.x, snapped.y, snapped.width, snapped.height, tintRgb, 1, true, false, false);
      };
      const okTL = drawPiece(quad.TL, x, y, halfWidth, halfHeight);
      const okTR = drawPiece(quad.TR, x + halfWidth, y, halfWidth, halfHeight);
      const okBL = drawPiece(quad.BL, x, y + halfHeight, halfWidth, halfHeight);
      const okBR = drawPiece(quad.BR, x + halfWidth, y + halfHeight, halfWidth, halfHeight);
      return okTL || okTR || okBL || okBR;
    }
    const snapped = pixelOutsetRect(x, y, width, height);
    const textureName = flipH ? `wall_${wallIndex}.png` : `wall_${wallIndex}_0.png`;
    return this.drawTextureFileModulated(textureName, snapped.x, snapped.y, snapped.width, snapped.height, tintRgb, 1, true, false, false);
  }

  /**
   * @param {any} floor
   * @param {number} x
   * @param {number} y
   * @param {number} size
   * @param {boolean} playerButton
   * @param {boolean} active
   * @param {any | null} state
   */
  drawGoalFrame(floor, x, y, size, playerButton, active, state = null) {
    const context = this.context;
    const exitBlock = floor.outerLevel?.exitBlock ?? floor.outerLevel?.blocksWithThisAsTheirSubLevel?.[0] ?? null;
    const base = exitBlock ? resolveDrawBaseHsv(exitBlock) : { hue: 0.58, sat: 0.2, val: 0.75 };
    const resolvedActive = playerButton ? Boolean(state?.buttonsSatisfied ?? active) : Boolean(state?.finishesSatisfied ?? active);
    const colorCss = this.hsvToCssAlpha(base.hue, clamp(base.sat * 0.75, 0, 1), 1, resolvedActive ? 0.3 : 0.6);
    const outerInset = size * 0.0664;
    const thicknessX = Math.max(1, Math.round(size * 0.0725));
    const thicknessY = Math.max(1, Math.round(size * 0.0725));
    const left = x + outerInset;
    const top = y + outerInset;
    const right = x + size - outerInset - thicknessX;
    const bottom = y + size - outerInset - thicknessY;
    const span = size - outerInset * 2;
    const verticalSpan = size - outerInset * 2 - thicknessY * 2;
    context.save();
    context.fillStyle = colorCss;
    context.fillRect(left, top, span, thicknessY);
    context.fillRect(left, bottom, span, thicknessY);
    context.fillRect(left, top + thicknessY, thicknessX, Math.max(0, verticalSpan));
    context.fillRect(right, top + thicknessY, thicknessX, Math.max(0, verticalSpan));

    if (playerButton) {
      const key = size > 56 ? "playerButtonEyesLarge" : "playerButtonEyes";
      this.drawTextureTinted(key, x, y, size, size, colorCss, 1);
    }
    context.restore();
  }

  /**
   * Expand viewport one nesting level outward.
   * Mirrors C# Draw.GoOutOneLevel (simplified for static blocks).
   * @param {any} block - the exit block of the current level
   * @param {{ x: number, y: number, w: number, h: number }} vp - viewport center+size
   */
  goOutOneLevel(block, vp, flipHState) {
    const outerLevel = block.outerLevel;
    if (!outerLevel) return;
    vp.w /= (block.drawXScale ?? 1);
    vp.h /= (block.drawYScale ?? 1);
    let bx = block.xpos;
    let by = block.ypos;
    let ox = block.drawXOffset ?? 0;
    let oy = block.drawYOffset ?? 0;
    flipHState.value = flipHState.value !== (block.flipH ?? false);
    if (flipHState.value) {
      bx = outerLevel.width - 1 - bx;
      ox *= -1;
    }
    vp.x -= (bx - (outerLevel.width - 1) / 2 + ox) * vp.w;
    // Canvas Y points down, opposite Unity's screen-space Y in Draw.GoOutOneLevel.
    vp.y -= (by - (outerLevel.height - 1) / 2 + oy) * vp.h;
    vp.w *= outerLevel.width;
    vp.h *= outerLevel.height;
  }

  /**
   * @param {any} state
   * @param {{ animation?: any, infoText?: string | null, emptyText?: string | null }} [options]
   */
  render(state, options = {}) {
    const context = this.context;
    const width = this.canvas.width / this.pixelRatio;
    const height = this.canvas.height / this.pixelRatio;
    const renderStart = typeof performance !== "undefined" ? performance.now() : 0;
    this._renderFrameCount = (this._renderFrameCount ?? 0) + 1;
    this._compactPreviewCount = 0;
    this._renderStats = {
      ms: 0,
      frameMs: 0,
      drawLevelInternal: 0,
      drawBlockRect: 0,
      drawCompactLevelPreview: 0,
      shellFallbacks: 0,
      ticketsProcessed: 0,
      cacheHits: 0,
      cacheMisses: 0,
      skippedTiny: 0,
      wallTextureDraws: 0,
      cacheClears: 0,
      cacheClearReason: "",
      cacheCreates: 0,
      cacheCreatePixels: 0,
      cacheEntries: 0,
      cacheTotalPixels: 0,
      cacheKeySamples: [],
      cacheDimensionMisses: 0,
      stableCacheDraws: 0,
      animationBackingDraws: 0,
      animationBackingCreates: 0,
      animationBackingHits: 0,
      animationMovingOverlayDraws: 0,
      animationMovingOverlayBlocks: 0,
      animationDirectBypass: 0,
      directNestedDraws: 0,
      directNestedReasons: {},
      directNestedSamples: [],
      cacheEvictions: 0,
      cacheEvictedPixels: 0,
      cacheTooLarge: 0,
      cacheInProgress: 0,
      cacheFallbackNoContext: 0,
      animationActive: Boolean(options.animation),
      animationDirection: options.animation?.direction ?? null,
      animationProgress: Number.isFinite(options.animation?.progress) ? Number(options.animation.progress.toFixed(3)) : null,
      animatedMoveCount: options.animation?.turn?.moves?.length ?? 0,
      renderPhantomCount: options.animation?.turn?.renderPhantoms?.length ?? 0,
      focusDebug: null,
      turnDebug: null,
      outwardChainDebug: []
    };
    this.prepareNestedLevelCache(state, Boolean(options.animation));

    context.clearRect(0, 0, width, height);
    context.fillStyle = "#091015";
    context.fillRect(0, 0, width, height);

    if (!state?.focusBlock?.outerLevel) {
      this.drawEmpty(width, height, options.emptyText ?? "点击左侧关卡开始");
      this.finishRenderStats(renderStart);
      return;
    }

    const animation = options.animation ?? null;
    prepareAnimationLookups(animation);
    const focusBlock = resolveRenderFocusBlock(state, animation);
    if (!focusBlock?.subLevel) {
      this.drawEmpty(width, height, options.emptyText ?? "点击左侧关卡开始");
      this.finishRenderStats(renderStart);
      return;
    }

    const cameraFlipH = Boolean(this.cameraFlipH);
    const drawViewport = computeFocusBlockViewport(focusBlock, width, height, animation, cameraFlipH);
    adjustSelfReferenceEnterViewport(state, focusBlock, drawViewport, width, height, cameraFlipH);
    const flipHState = { value: cameraFlipH };
    let drawBlock = focusBlock;
    let drawLevel = focusBlock.subLevel;
    const seenExitBlocks = new Set();
    const outwardBlocks = [];
    if (this._renderStats) {
      this._renderStats.focusDebug = {
        focusBlockId: focusBlock?.id ?? null,
        focusLevelId: focusBlock?.subLevel?.id ?? null,
        progress: animation ? Math.round((animation.progress ?? 1) * 1000) / 1000 : null,
        viewportX: Math.round(drawViewport.x * 10) / 10,
        viewportY: Math.round(drawViewport.y * 10) / 10,
        viewportW: Math.round(drawViewport.w * 10) / 10,
        viewportH: Math.round(drawViewport.h * 10) / 10,
        useEnterFocusChain: shouldUseEnterFocusChain(state, animation)
      };

      const summarizeDebugBlock = (debugBlock) => debugBlock ? {
        id: debugBlock.id ?? null,
        kind: debugBlock.kind ?? null,
        xpos: debugBlock.xpos ?? null,
        ypos: debugBlock.ypos ?? null,
        outerLevelId: debugBlock.outerLevel?.id ?? null,
        subLevelId: debugBlock.subLevel?.id ?? null
      } : null;
      const summarizeJustEnteredArray = (debugBlock) =>
        (debugBlock?.justEnteredArray ?? []).slice(0, 8).map((entry, index) => ({
          index,
          ...summarizeDebugBlock(entry)
        }));
      const turn = animation?.turn ?? null;
      this._renderStats.turnDebug = {
        cameraProjection: turn?.cameraProjection ? { ...turn.cameraProjection } : null,
        cameraMovedThisTurn: Boolean(turn?.cameraMovedThisTurn),
        camX: turn?.camX ?? null,
        camY: turn?.camY ?? null,
        camXS: turn?.camXS ?? null,
        camYS: turn?.camYS ?? null,
        animLengthSeconds: turn?.animLengthSeconds ?? null,
        instantZoom: Boolean(state?.prefs?.instantZoom),
        playerBlock: summarizeDebugBlock(state?.focusBlock ?? state?.playerBlocks?.[0] ?? null),
        renderFocusBlock: summarizeDebugBlock(focusBlock),
        playerJustEnteredArray: summarizeJustEnteredArray(state?.focusBlock ?? state?.playerBlocks?.[0] ?? null),
        focusJustEnteredArray: summarizeJustEnteredArray(focusBlock),
        moves: (turn?.moves ?? []).slice(0, 8).map((move, index) => ({
          index,
          blockId: move?.block?.id ?? move?.mover?.id ?? null,
          fromLevelId: move?.fromLevel?.id ?? null,
          toLevelId: move?.toLevel?.id ?? null,
          fromX: move?.fromX ?? null,
          fromY: move?.fromY ?? null,
          toX: move?.toX ?? null,
          toY: move?.toY ?? null,
          fromFlipH: move?.fromFlipH ?? null,
          toFlipH: move?.toFlipH ?? null,
          animKind: move?.animKind ?? move?.animType ?? null,
          animXOffset: move?.animXOffset ?? null,
          animYOffset: move?.animYOffset ?? null,
          animXScale: move?.animXScale ?? null,
          animYScale: move?.animYScale ?? null
        })),
        renderPhantoms: (turn?.renderPhantoms ?? []).slice(0, 8).map((phantom, index) => ({
          index,
          outerLevelId: phantom?.outerLevel?.id ?? null,
          blockId: phantom?.block?.id ?? null,
          fromLevelId: phantom?.fromLevel?.id ?? null,
          toLevelId: phantom?.toLevel?.id ?? null
        }))
      };
    }

    for (let index = 0; index < computeLevelsUp(state); index += 1) {
      if (!shouldGoOutOneLevel(drawBlock, drawLevel, seenExitBlocks)) {
        break;
      }
      const previousBlock = drawBlock;
      const outerLevel = drawBlock.outerLevel;
      outwardBlocks.push(drawBlock);
      this.goOutOneLevel(drawBlock, drawViewport, flipHState);
      const resolved = resolveCSharpOutwardBlock(state, animation, index, outerLevel, outwardBlocks);
      drawBlock = resolved.block ?? null;
      if (this._renderStats && this._renderStats.outwardChainDebug.length < 8) {
        this._renderStats.outwardChainDebug.push({
          step: index,
          previousBlockId: previousBlock?.id ?? null,
          outerLevelId: outerLevel?.id ?? null,
          chosenBlockId: drawBlock?.id ?? null,
          source: resolved.source
        });
      }
      drawLevel = drawBlock?.subLevel ?? outerLevel;
    }

    const cellSize = Math.max(0.5, Math.min(drawViewport.w / drawLevel.width, drawViewport.h / drawLevel.height));
    const originX = drawViewport.x - (drawLevel.width * cellSize) / 2;
    const originY = drawViewport.y - (drawLevel.height * cellSize) / 2;
    this.drawLevel(
      state,
      drawLevel,
      originX,
      originY,
      cellSize,
      animation,
      0,
      new Set([drawLevel.id]),
      drawBlock,
      [],
      flipHState.value
    );

    if (options.infoText) {
      this.drawInfo(width, height, options.infoText);
    }
    this.finishRenderStats(renderStart);
  }

  /**
   * @param {number} renderStart
   */
  finishRenderStats(renderStart) {
    if (!this._renderStats) {
      return;
    }
    const frameMs = typeof performance !== "undefined" ? performance.now() - renderStart : 0;
    this._renderStats.ms = frameMs;
    this._renderStats.frameMs = frameMs;
    this._renderStats.cacheEntries = this.nestedLevelCache.size;
    this._renderStats.cacheTotalPixels = this.nestedLevelCacheTotalPixels;
    this.lastRenderStats = this._renderStats;
    if (frameMs > 100) {
      this.lastSlowFrame = { ms: frameMs, ...this._renderStats };
    }
    this.recordDebugFrame(this._renderStats);
    this._renderStats = null;
  }

  installDebugHooks() {
    if (typeof globalThis === "undefined") {
      return;
    }
    const renderer = this;
    globalThis.__patrickRenderDebug = {
      config: globalThis.__patrickRenderDebugConfig ?? {},
      reset() {
        renderer.debugFrames = [];
        renderer.debugDroppedFrames = 0;
        renderer.debugStartTime = typeof performance !== "undefined" ? performance.now() : Date.now();
        renderer.lastSlowFrame = null;
        renderer.lastRenderStats = null;
        return "render debug buffer reset";
      },
      dump() {
        return renderer.getDebugDump();
      },
      dumpText() {
        return JSON.stringify(renderer.getDebugDump(), null, 2);
      },
      summary() {
        return renderer.getDebugSummary();
      },
      printSummary() {
        console.table(renderer.getDebugSummary().topSlowFrames);
        return renderer.getDebugSummary();
      }
    };
  }

  getDebugConfig() {
    const cfg = (typeof globalThis !== "undefined" && globalThis.__patrickRenderDebug?.config) ||
      (typeof globalThis !== "undefined" && globalThis.__patrickRenderDebugConfig) ||
      {};
    return {
      enabled: cfg.enabled !== false,
      captureAllFrames: Boolean(cfg.captureAllFrames),
      slowMs: Number.isFinite(cfg.slowMs) ? cfg.slowMs : RENDER_DEBUG_DEFAULT_SLOW_MS,
      maxFrames: Number.isFinite(cfg.maxFrames) ? Math.max(20, Math.floor(cfg.maxFrames)) : RENDER_DEBUG_DEFAULT_MAX_FRAMES,
      maxSamples: Number.isFinite(cfg.maxSamples) ? Math.max(0, Math.floor(cfg.maxSamples)) : RENDER_DEBUG_DEFAULT_MAX_SAMPLES
    };
  }

  compactDebugStats(stats, maxSamples) {
    const pick = {
      frame: this._renderFrameCount ?? 0,
      t: Math.round(((typeof performance !== "undefined" ? performance.now() : Date.now()) - this.debugStartTime) * 10) / 10,
      frameMs: Math.round((stats.frameMs ?? 0) * 10) / 10,
      animationActive: stats.animationActive,
      animationDirection: stats.animationDirection,
      animationProgress: stats.animationProgress,
      animatedMoveCount: stats.animatedMoveCount,
      renderPhantomCount: stats.renderPhantomCount,
      drawLevelInternal: stats.drawLevelInternal,
      drawBlockRect: stats.drawBlockRect,
      drawCompactLevelPreview: stats.drawCompactLevelPreview,
      shellFallbacks: stats.shellFallbacks,
      ticketsProcessed: stats.ticketsProcessed,
      cacheHits: stats.cacheHits,
      cacheMisses: stats.cacheMisses,
      cacheCreates: stats.cacheCreates,
      cacheCreatePixels: stats.cacheCreatePixels,
      cacheClears: stats.cacheClears,
      cacheClearReason: stats.cacheClearReason,
      cacheEntries: stats.cacheEntries,
      cacheTotalPixels: stats.cacheTotalPixels,
      cacheDimensionMisses: stats.cacheDimensionMisses,
      cacheEvictions: stats.cacheEvictions,
      cacheEvictedPixels: stats.cacheEvictedPixels,
      cacheTooLarge: stats.cacheTooLarge,
      cacheInProgress: stats.cacheInProgress,
      cacheFallbackNoContext: stats.cacheFallbackNoContext,
      stableCacheDraws: stats.stableCacheDraws,
      animationBackingDraws: stats.animationBackingDraws,
      animationBackingCreates: stats.animationBackingCreates,
      animationBackingHits: stats.animationBackingHits,
      animationMovingOverlayDraws: stats.animationMovingOverlayDraws,
      animationMovingOverlayBlocks: stats.animationMovingOverlayBlocks,
      animationDirectBypass: stats.animationDirectBypass,
      focusDebug: stats.focusDebug ? { ...stats.focusDebug } : null,
      turnDebug: stats.turnDebug ? JSON.parse(JSON.stringify(stats.turnDebug)) : null,
      outwardChainDebug: (stats.outwardChainDebug ?? []).map((entry) => ({ ...entry })),
      directNestedDraws: stats.directNestedDraws,
      directNestedReasons: { ...(stats.directNestedReasons ?? {}) },
      skippedTiny: stats.skippedTiny,
      wallTextureDraws: stats.wallTextureDraws
    };
    if (maxSamples > 0) {
      pick.cacheKeySamples = (stats.cacheKeySamples ?? []).slice(0, maxSamples);
      pick.directNestedSamples = (stats.directNestedSamples ?? []).slice(0, maxSamples);
    }
    return pick;
  }

  recordDebugFrame(stats) {
    const cfg = this.getDebugConfig();
    if (!cfg.enabled) {
      return;
    }
    const slow = (stats.frameMs ?? 0) >= cfg.slowMs;
    const interesting = Boolean(
      slow ||
      cfg.captureAllFrames ||
      stats.cacheClears > 0 ||
      stats.cacheMisses > 0 ||
      stats.cacheCreates > 0 ||
      stats.cacheEvictions > 0 ||
      stats.cacheTooLarge > 0 ||
      stats.directNestedDraws > 0 ||
      stats.animationBackingDraws > 0 ||
      stats.animationMovingOverlayDraws > 0 ||
      stats.wallTextureDraws > 200
    );
    if (!interesting) {
      return;
    }
    this.debugFrames.push(this.compactDebugStats(stats, cfg.maxSamples));
    while (this.debugFrames.length > cfg.maxFrames) {
      this.debugFrames.shift();
      this.debugDroppedFrames += 1;
    }
  }

  getDebugSummary() {
    const frames = this.debugFrames ?? [];
    const sum = (field) => frames.reduce((acc, frame) => acc + (Number(frame[field]) || 0), 0);
    const max = (field) => frames.reduce((acc, frame) => Math.max(acc, Number(frame[field]) || 0), 0);
    const reasonTotals = {};
    for (const frame of frames) {
      for (const [reason, count] of Object.entries(frame.directNestedReasons ?? {})) {
        reasonTotals[reason] = (reasonTotals[reason] ?? 0) + count;
      }
    }
    const clearReasons = {};
    for (const frame of frames) {
      if (frame.cacheClearReason) {
        clearReasons[frame.cacheClearReason] = (clearReasons[frame.cacheClearReason] ?? 0) + 1;
      }
    }
    return {
      capturedFrames: frames.length,
      droppedFrames: this.debugDroppedFrames,
      maxFrameMs: max("frameMs"),
      totalCacheHits: sum("cacheHits"),
      totalCacheMisses: sum("cacheMisses"),
      totalCacheCreates: sum("cacheCreates"),
      totalCacheCreatePixels: sum("cacheCreatePixels"),
      totalDirectNestedDraws: sum("directNestedDraws"),
      totalStableCacheDraws: sum("stableCacheDraws"),
      totalAnimationBackingDraws: sum("animationBackingDraws"),
      totalAnimationBackingCreates: sum("animationBackingCreates"),
      totalAnimationBackingHits: sum("animationBackingHits"),
      totalAnimationMovingOverlayDraws: sum("animationMovingOverlayDraws"),
      totalAnimationMovingOverlayBlocks: sum("animationMovingOverlayBlocks"),
      totalAnimationDirectBypass: sum("animationDirectBypass"),
      totalCacheTooLarge: sum("cacheTooLarge"),
      totalCacheEvictions: sum("cacheEvictions"),
      totalWallTextureDraws: sum("wallTextureDraws"),
      directNestedReasons: reasonTotals,
      cacheClearReasons: clearReasons,
      topSlowFrames: [...frames]
        .sort((a, b) => b.frameMs - a.frameMs)
        .slice(0, 12)
        .map((frame) => ({
          frame: frame.frame,
          t: frame.t,
          frameMs: frame.frameMs,
          anim: frame.animationActive,
          progress: frame.animationProgress,
          direct: frame.directNestedDraws,
          backing: frame.animationBackingDraws,
          backingHits: frame.animationBackingHits,
          backingCreates: frame.animationBackingCreates,
          overlay: frame.animationMovingOverlayDraws,
          overlayBlocks: frame.animationMovingOverlayBlocks,
          directReasons: frame.directNestedReasons,
          hits: frame.cacheHits,
          miss: frame.cacheMisses,
          creates: frame.cacheCreates,
          clear: frame.cacheClearReason,
          blocks: frame.drawBlockRect,
          levels: frame.drawLevelInternal,
          walls: frame.wallTextureDraws
        }))
    };
  }

  getDebugDump() {
    return {
      summary: this.getDebugSummary(),
      lastRenderStats: this.lastRenderStats,
      lastSlowFrame: this.lastSlowFrame,
      frames: this.debugFrames
    };
  }

  /**
   * @param {any} state
   */
  clearNestedLevelCache(reason = "") {
    this.nestedLevelCache.clear();
    this.nestedLevelCacheTotalPixels = 0;
    this.nestedLevelCacheInProgress.clear();
    this.nestedLevelCacheLastFullKeyByBaseKey.clear();
    if (this._renderStats) {
      this._renderStats.cacheClears += 1;
      this._renderStats.cacheClearReason = reason;
    }
  }

  prepareNestedLevelCache(state, hasAnimation = false) {
    let clearReason = "";
    if (this._lastStateRef && this._lastStateRef !== state) {
      clearReason = "state-ref";
    }
    this._lastStateRef = state;
    const stateKey = buildNestedRenderStateKey(state);
    if (!clearReason && this.nestedLevelCacheStateKey !== stateKey) {
      clearReason = "state-key";
    }
    if (!clearReason && this.nestedLevelCacheAssetVersion !== this.assetVersion) {
      clearReason = "asset-version";
    }
    if (!clearReason && this.nestedLevelCachePixelRatio !== this.pixelRatio) {
      clearReason = "pixel-ratio";
    }
    if (!clearReason && this._lastHadAnimation !== hasAnimation) {
      clearReason = hasAnimation ? "animation-start" : "animation-end";
    }
    this._lastHadAnimation = hasAnimation;
    if (clearReason) {
      this.clearNestedLevelCache(clearReason);
      this.nestedLevelCacheStateKey = stateKey;
      this.nestedLevelCacheAssetVersion = this.assetVersion;
      this.nestedLevelCachePixelRatio = this.pixelRatio;
    }
    this.nestedLevelCacheInProgress.clear();
  }

  /**
   * @param {any} state
   * @param {any} level
   * @param {any} ownerBlock
   * @param {number} width
   * @param {number} height
   * @param {boolean} flipH
   * @param {number} depth
   * @returns {string}
   */
  makeNestedLevelCacheKey(state, level, ownerBlock, width, height, flipH, depth) {
    const BUCKET = 16;
    const widthBucket = Math.max(BUCKET, Math.round(width / BUCKET) * BUCKET);
    const heightBucket = Math.max(BUCKET, Math.round(height / BUCKET) * BUCKET);
    const depthRemaining = Math.max(0, MAX_SUBLEVEL_RENDER_DEPTH - depth);
    return [
      level?.id ?? 0,
      ownerBlock?.id ?? 0,
      widthBucket,
      heightBucket,
      flipH ? 1 : 0,
      depthRemaining,
      state?.drawStyle ?? "",
      state?.prefs?.grid ? 1 : 0
    ].join(":");
  }

  /**
   * @param {any} state
   * @param {any} level
   * @param {any} ownerBlock
   * @param {boolean} flipH
   * @param {number} depth
   * @returns {string}
   */
  makeNestedLevelCacheBaseKey(state, level, ownerBlock, flipH, depth) {
    const depthRemaining = Math.max(0, MAX_SUBLEVEL_RENDER_DEPTH - depth);
    return [
      level?.id ?? 0,
      ownerBlock?.id ?? 0,
      flipH ? 1 : 0,
      depthRemaining,
      state?.drawStyle ?? "",
      state?.prefs?.grid ? 1 : 0
    ].join(":");
  }

  /**
   * @param {string} key
   * @param {{ canvas: HTMLCanvasElement, width: number, height: number }} entry
   */
  storeNestedLevelCacheEntry(key, entry) {
    const old = this.nestedLevelCache.get(key);
    if (old) {
      this.nestedLevelCacheTotalPixels -= old.pixels ?? old.width * old.height;
      this.nestedLevelCache.delete(key);
    }
    entry.pixels = entry.width * entry.height;
    this.nestedLevelCache.set(key, entry);
    this.nestedLevelCacheTotalPixels += entry.pixels;
    while (
      this.nestedLevelCache.size > MAX_NESTED_LEVEL_CACHE_ENTRIES ||
      this.nestedLevelCacheTotalPixels > MAX_NESTED_LEVEL_CACHE_TOTAL_PIXELS
    ) {
      const oldestKey = this.nestedLevelCache.keys().next().value;
      const oldest = this.nestedLevelCache.get(oldestKey);
      this.nestedLevelCache.delete(oldestKey);
      const evictedPixels = oldest?.pixels ?? ((oldest?.width ?? 0) * (oldest?.height ?? 0));
      this.nestedLevelCacheTotalPixels -= evictedPixels;
      if (this._renderStats) {
        this._renderStats.cacheEvictions += 1;
        this._renderStats.cacheEvictedPixels += evictedPixels;
      }
    }
    if (this.nestedLevelCacheTotalPixels < 0) {
      this.nestedLevelCacheTotalPixels = 0;
    }
  }

  /**
   * @param {any} state
   * @param {any} block
   * @param {{ x: number, y: number, width: number, height: number }} nestedWindow
   * @param {{ originX: number, originY: number, cellSize: number }} viewport
   * @param {any} animation
   * @param {number} childDepth
   * @param {Set<number>} path
   * @param {any | null} parentBlock
   * @param {Array<any>} parents
   * @param {boolean} flipH
   * @param {number} levelScreenOriginX
   * @param {number} levelScreenOriginY
   */
  drawNestedLevelDirect(
    state,
    block,
    nestedWindow,
    viewport,
    animation,
    childDepth,
    path,
    parentBlock,
    parents,
    flipH,
    levelScreenOriginX,
    levelScreenOriginY
  ) {
    const context = this.context;
    const childPath = new Set(path);
    childPath.add(block.subLevel.id);
    const childParents = parentBlock ? [parentBlock, ...parents] : [];
    context.save();
    context.beginPath();
    context.rect(nestedWindow.x, nestedWindow.y, nestedWindow.width, nestedWindow.height);
    context.clip();
    this.drawLevelInternal(
      state,
      block.subLevel,
      viewport.originX,
      viewport.originY,
      viewport.cellSize,
      animation,
      childDepth,
      childPath,
      block,
      childParents,
      flipH,
      levelScreenOriginX,
      levelScreenOriginY
    );
    context.restore();
  }


  /**
   * Draw only moving/phantom content over an animation backing.
   * Static blocks remain in the backing cache; moving blocks are drawn live.
   */
  drawAnimatedNestedMovingOverlay(
    state,
    block,
    nestedWindow,
    viewport,
    animation,
    childDepth,
    path,
    parentBlock,
    parents,
    flipH,
    levelScreenOriginX,
    levelScreenOriginY
  ) {
    if (!animation || !block?.subLevel) {
      return;
    }
    const context = this.context;
    const childPath = new Set(path);
    childPath.add(block.subLevel.id);
    const childParents = parentBlock ? [parentBlock, ...parents] : [];
    const previousOnly = this._drawOnlyAnimatedBlocksOverlay;
    this._drawOnlyAnimatedBlocksOverlay = true;
    if (this._renderStats) {
      this._renderStats.animationMovingOverlayDraws += 1;
    }
    context.save();
    context.beginPath();
    context.rect(nestedWindow.x, nestedWindow.y, nestedWindow.width, nestedWindow.height);
    context.clip();
    try {
      this.drawLevelInternal(
        state,
        block.subLevel,
        viewport.originX,
        viewport.originY,
        viewport.cellSize,
        animation,
        childDepth,
        childPath,
        block,
        childParents,
        flipH,
        levelScreenOriginX,
        levelScreenOriginY
      );
    } finally {
      this._drawOnlyAnimatedBlocksOverlay = previousOnly;
      context.restore();
    }
  }

  /**
   * @param {any} state
   * @param {any} block
   * @param {{ x: number, y: number, width: number, height: number }} nestedWindow
   * @param {{ x: number, y: number, width: number, height: number } | null} stableWindow
   * @param {any} animation
   * @param {number} childDepth
   * @param {Set<number>} path
   * @param {any | null} parentBlock
   * @param {Array<any>} parents
   * @param {boolean} flipH
   * @param {number} parentScreenOriginX
   * @param {number} parentScreenOriginY
   * @returns {boolean}
   */
  drawNestedLevelCached(
    state,
    block,
    nestedWindow,
    stableWindow,
    animation,
    childDepth,
    path,
    parentBlock,
    parents,
    flipH,
    parentScreenOriginX,
    parentScreenOriginY
  ) {
    const animationMode = (typeof globalThis !== "undefined" && globalThis.__patrickRenderDebug?.config?.animationNestedMode) ||
      (typeof globalThis !== "undefined" && globalThis.__patrickRenderDebugConfig?.animationNestedMode) ||
      "stable-backing";
    const configuredBackingSize = Number(
      (typeof globalThis !== "undefined" && globalThis.__patrickRenderDebug?.config?.animationBackingSize) ??
      (typeof globalThis !== "undefined" && globalThis.__patrickRenderDebugConfig?.animationBackingSize) ??
      512
    );
    const canonicalBackingSize = Math.max(128, Math.min(1024, Number.isFinite(configuredBackingSize) ? configuredBackingSize : 512));
    const useAnimationBacking = Boolean(animation && animationMode !== "direct");
    const cacheWindow = useAnimationBacking
      ? { x: 0, y: 0, width: canonicalBackingSize, height: canonicalBackingSize }
      : (stableWindow ?? nestedWindow);
    const pixelStep = this.pixelRatio ? 1 / this.pixelRatio : 1;
    const viewport = computeLevelViewport(
      block.subLevel,
      nestedWindow.x,
      nestedWindow.y,
      nestedWindow.width,
      nestedWindow.height,
      0,
      0.5,
      pixelStep
    );
    const drawDirect = (reason = "direct") => {
      if (this._renderStats) {
        this._renderStats.directNestedDraws += 1;
        this._renderStats.directNestedReasons[reason] = (this._renderStats.directNestedReasons[reason] ?? 0) + 1;
        if (this._renderStats.directNestedSamples.length < 16) {
          this._renderStats.directNestedSamples.push({
            reason,
            levelId: block.subLevel?.id ?? null,
            ownerBlockId: block.id ?? null,
            childDepth,
            nestedWidth: Math.round(nestedWindow.width * 10) / 10,
            nestedHeight: Math.round(nestedWindow.height * 10) / 10,
            cacheWidth: Math.round(cacheWindow.width * 10) / 10,
            cacheHeight: Math.round(cacheWindow.height * 10) / 10,
            animationActive: Boolean(animation),
            animationProgress: Number.isFinite(animation?.progress) ? Math.round(animation.progress * 1000) / 1000 : null
          });
        }
      }
      this.drawNestedLevelDirect(
        state,
        block,
        nestedWindow,
        viewport,
        animation,
        childDepth,
        path,
        parentBlock,
        parents,
        flipH,
        parentScreenOriginX + viewport.originX,
        parentScreenOriginY + viewport.originY
      );
    };

    if (animation && !useAnimationBacking) {
      if (this._renderStats) {
        this._renderStats.animationDirectBypass += 1;
      }
      drawDirect("animation");
      return true;
    }

    const pixelRatio = this.pixelRatio || 1;
    const maxCachePixels = Math.max(1, (this.canvas?.width ?? 1920) * (this.canvas?.height ?? 1080));
    let cachePixelRatio = pixelRatio;
    while (
      cachePixelRatio > 1 &&
      Math.ceil(cacheWindow.width * cachePixelRatio) * Math.ceil(cacheWindow.height * cachePixelRatio) > maxCachePixels
    ) {
      cachePixelRatio = 1;
    }
    const cachePixelWidth = Math.max(1, Math.ceil(cacheWindow.width * cachePixelRatio));
    const cachePixelHeight = Math.max(1, Math.ceil(cacheWindow.height * cachePixelRatio));
    if (typeof document === "undefined" || cachePixelWidth * cachePixelHeight > MAX_NESTED_LEVEL_CACHE_PIXELS) {
      if (this._renderStats) {
        this._renderStats.cacheTooLarge += 1;
      }
      drawDirect(typeof document === "undefined" ? "no-document" : "cache-too-large");
      return true;
    }

    const baseKey = this.makeNestedLevelCacheBaseKey(state, block.subLevel, block, flipH, childDepth);
    const key = useAnimationBacking
      ? [
          "animationBacking",
          baseKey,
          Math.round(canonicalBackingSize),
          block.subLevel?.width ?? 0,
          block.subLevel?.height ?? 0
        ].join(":")
      : this.makeNestedLevelCacheKey(state, block.subLevel, block, cacheWindow.width, cacheWindow.height, flipH, childDepth);

    const cached = this.nestedLevelCache.get(key);
    if (cached) {
      this.nestedLevelCache.delete(key);
      this.nestedLevelCache.set(key, cached);
      if (this._renderStats) {
        this._renderStats.cacheHits += 1;
        this._renderStats.ticketsProcessed += 1;
        this._renderStats.stableCacheDraws += 1;
        if (useAnimationBacking) {
          this._renderStats.animationBackingDraws += 1;
          this._renderStats.animationBackingHits += 1;
        }
      }
      this.context.drawImage(cached.canvas, 0, 0, cached.width, cached.height, nestedWindow.x, nestedWindow.y, nestedWindow.width, nestedWindow.height);
      if (useAnimationBacking) {
        this.drawAnimatedNestedMovingOverlay(
          state,
          block,
          nestedWindow,
          viewport,
          animation,
          childDepth,
          path,
          parentBlock,
          parents,
          flipH,
          parentScreenOriginX + viewport.originX,
          parentScreenOriginY + viewport.originY
        );
      }
      return true;
    }
    if (this.nestedLevelCacheInProgress.has(key)) {
      if (this._renderStats) {
        this._renderStats.skippedTiny += 1;
        this._renderStats.cacheInProgress += 1;
      }
      return false;
    }

    if (this._renderStats) {
      this._renderStats.cacheMisses += 1;
      const prevFullKey = this.nestedLevelCacheLastFullKeyByBaseKey.get(baseKey);
      if (!useAnimationBacking && prevFullKey && prevFullKey !== key) {
        this._renderStats.cacheDimensionMisses += 1;
      }
      if (this._renderStats.cacheKeySamples.length < 8) {
        this._renderStats.cacheKeySamples.push({
          key,
          baseKey,
          cacheWidth: cacheWindow.width,
          cacheHeight: cacheWindow.height,
          cachePixelWidth,
          cachePixelHeight,
          cachePixelRatio,
          drawWidth: nestedWindow.width,
          drawHeight: nestedWindow.height,
          levelId: block.subLevel?.id ?? null,
          ownerBlockId: block.id ?? null,
          childDepth,
          animationBacking: useAnimationBacking
        });
      }
    }
    this.nestedLevelCacheLastFullKeyByBaseKey.set(baseKey, key);

    const cacheCanvas = document.createElement("canvas");
    cacheCanvas.width = cachePixelWidth;
    cacheCanvas.height = cachePixelHeight;
    const cacheContext = cacheCanvas.getContext("2d");
    if (!cacheContext) {
      if (this._renderStats) {
        this._renderStats.cacheFallbackNoContext += 1;
      }
      drawDirect("no-cache-context");
      return true;
    }
    cacheContext.setTransform(cachePixelRatio, 0, 0, cachePixelRatio, 0, 0);
    cacheContext.clearRect(0, 0, cacheWindow.width, cacheWindow.height);

    const previousContext = this.context;
    const previousSkipAnimated = this._skipAnimatedBlocksForBacking;
    this.context = cacheContext;
    this.nestedLevelCacheInProgress.add(key);
    if (useAnimationBacking) {
      this._skipAnimatedBlocksForBacking = true;
    }
    try {
      const localWindow = { x: 0, y: 0, width: cacheWindow.width, height: cacheWindow.height };
      const localViewport = computeLevelViewport(block.subLevel, 0, 0, cacheWindow.width, cacheWindow.height, 0, 0.5, pixelStep);
      this.drawNestedLevelDirect(
        state,
        block,
        localWindow,
        localViewport,
        useAnimationBacking ? animation : null,
        childDepth,
        path,
        parentBlock,
        parents,
        flipH,
        localViewport.originX,
        localViewport.originY
      );
    } finally {
      this.nestedLevelCacheInProgress.delete(key);
      this._skipAnimatedBlocksForBacking = previousSkipAnimated;
      this.context = previousContext;
    }

    const entry = { canvas: cacheCanvas, width: cachePixelWidth, height: cachePixelHeight };
    this.storeNestedLevelCacheEntry(key, entry);
    if (this._renderStats) {
      this._renderStats.cacheCreates += 1;
      this._renderStats.cacheCreatePixels += cachePixelWidth * cachePixelHeight;
      if (useAnimationBacking) {
        this._renderStats.animationBackingDraws += 1;
        this._renderStats.animationBackingCreates += 1;
      }
    }
    this.context.drawImage(cacheCanvas, 0, 0, cachePixelWidth, cachePixelHeight, nestedWindow.x, nestedWindow.y, nestedWindow.width, nestedWindow.height);
    if (useAnimationBacking) {
      this.drawAnimatedNestedMovingOverlay(
        state,
        block,
        nestedWindow,
        viewport,
        animation,
        childDepth,
        path,
        parentBlock,
        parents,
        flipH,
        parentScreenOriginX + viewport.originX,
        parentScreenOriginY + viewport.originY
      );
    }
    return true;
  }

  /**
   * @param {any} state
   * @param {any} animation
   * @returns {{ playerMove: any, isEnter: boolean, isExit: boolean, isEnterExit: boolean, progress: number, reverse: boolean } | null}
   */
  resolveEnterExitTransition(state, animation) {
    // C# keeps enter/exit as per-block Projection offsets plus phantoms. A
    // full-level zoom makes exiting blocks appear to teleport at room borders.
    return null;
  }

  /**
   * @param {any} state
   * @param {any} level
   * @param {number} cx
   * @param {number} cy
   * @param {number} cellSize
   * @param {number} canvasWidth
   * @param {number} canvasHeight
   */
  drawZoomedLevel(state, level, cx, cy, cellSize, canvasWidth, canvasHeight) {
    const context = this.context;
    const drawWidth = level.width * cellSize;
    const drawHeight = level.height * cellSize;
    const originX = cx - drawWidth / 2;
    const originY = cy - drawHeight / 2;

    context.save();
    context.beginPath();
    context.rect(0, 0, canvasWidth, canvasHeight);
    context.clip();

    this.drawLevel(state, level, originX, originY, cellSize, null, 0, new Set([level.id]), null, [], false);

    context.restore();
  }

  /**
   * @param {number} width
   * @param {number} height
   */
  drawEmpty(width, height, text = "点击左侧关卡开始") {
    const context = this.context;
    context.fillStyle = "#cfe3e7";
    context.font = '600 20px "Jost Demake", "Segoe UI", sans-serif';
    context.textAlign = "center";
    context.fillText(text, width / 2, height / 2);
  }

  /**
   * @param {any} state
   * @param {any} level
   * @param {number} originX
   * @param {number} originY
   * @param {number} cellSize
   * @param {any} animation
   * @param {number} depth
   * @param {Set<number>} [path]
   * @param {any | null} [parentBlock]
   */
  drawLevel(
    state,
    level,
    originX,
    originY,
    cellSize,
    animation,
    depth,
    path = new Set([level.id]),
    parentBlock = null,
    parents = [],
    ticketFlipH = false,
    screenOriginX = originX,
    screenOriginY = originY
  ) {
    return this.drawLevelInternal(
      state,
      level,
      originX,
      originY,
      cellSize,
      animation,
      depth,
      path,
      parentBlock,
      parents,
      ticketFlipH,
      screenOriginX,
      screenOriginY
    );
  }

  /**
   * @param {any} state
   * @param {any} level
   * @param {number} originX
   * @param {number} originY
   * @param {number} cellSize
   * @param {any} animation
   * @param {number} depth
   * @param {Set<number>} path
   * @param {any | null} [parentBlock]
   * @param {Array<any>} [parents]
   * @param {boolean} [ticketFlipH]
   * @param {number} [screenOriginX]
   * @param {number} [screenOriginY]
   */
  drawLevelInternal(
    state,
    level,
    originX,
    originY,
    cellSize,
    animation,
    depth,
    path,
    parentBlock = null,
    parents = [],
    ticketFlipH = false,
    screenOriginX = originX,
    screenOriginY = originY
  ) {
    if (this._renderStats) {
      this._renderStats.drawLevelInternal += 1;
      this._renderStats.ticketsProcessed += 1;
    }
    const context = this.context;
    const levelWidth = level.width * cellSize;
    const levelHeight = level.height * cellSize;
    const ownerBlock = parentBlock ?? resolveLevelOwnerBlock(level);
    const scaffoldPalette = this.computeScaffoldPalette(ownerBlock, levelWidth, levelHeight);
    const levelMask = computeLevelWallMask(level);
    const levelRadius = Math.max(3, cellSize * 0.28);
    const onlyAnimatedOverlay = Boolean(this._drawOnlyAnimatedBlocksOverlay && animation);
    const skipAnimatedForBacking = Boolean(this._skipAnimatedBlocksForBacking && animation);
    const drawLevelBacking = depth === 0 && !onlyAnimatedOverlay;
    const rounded = {
      topLeft: levelMask.leftWall && levelMask.upWall ? levelRadius : 0,
      topRight: levelMask.rightWall && levelMask.upWall ? levelRadius : 0,
      bottomRight: levelMask.rightWall && levelMask.downWall ? levelRadius : 0,
      bottomLeft: levelMask.leftWall && levelMask.downWall ? levelRadius : 0
    };
    context.save();
    context.translate(originX, originY);

    if (drawLevelBacking) {
      context.fillStyle = this.hsvToCssAlpha(scaffoldPalette.fill.hue, scaffoldPalette.fill.sat * 0.75, clamp(scaffoldPalette.fill.val, 0, 1), 1);
      traceRoundedRect(context, 0, 0, levelWidth, levelHeight, rounded);
      context.fill();

      const innerFrame = Math.max(2, cellSize * 0.08);
      context.fillStyle = this.hsvToCssAlpha(
        scaffoldPalette.fill.hue,
        clamp(scaffoldPalette.fill.sat * 0.88, 0, 1),
        clamp(scaffoldPalette.fill.val * 1.35, 0, 1),
        0.22
      );
      traceRoundedRect(
        context,
        innerFrame,
        innerFrame,
        Math.max(0, levelWidth - innerFrame * 2),
        Math.max(0, levelHeight - innerFrame * 2),
        {
          topLeft: Math.max(0, rounded.topLeft - innerFrame),
          topRight: Math.max(0, rounded.topRight - innerFrame),
          bottomRight: Math.max(0, rounded.bottomRight - innerFrame),
          bottomLeft: Math.max(0, rounded.bottomLeft - innerFrame)
        }
      );
      context.fill();

      context.strokeStyle = this.hsvToCssAlpha(scaffoldPalette.line.hue, scaffoldPalette.line.sat, scaffoldPalette.line.val, 0.7);
      context.lineWidth = 2;
      traceRoundedRect(context, 0, 0, levelWidth, levelHeight, rounded);
      context.stroke();

      context.strokeStyle = this.hsvToCssAlpha(scaffoldPalette.line.hue, scaffoldPalette.line.sat, clamp(scaffoldPalette.line.val * 1.02, 0, 1), 0.12);
      context.lineWidth = 1;
      traceRoundedRect(
        context,
        innerFrame * 0.6,
        innerFrame * 0.6,
        Math.max(0, levelWidth - innerFrame * 1.2),
        Math.max(0, levelHeight - innerFrame * 1.2),
        {
          topLeft: Math.max(0, rounded.topLeft - innerFrame * 0.6),
          topRight: Math.max(0, rounded.topRight - innerFrame * 0.6),
          bottomRight: Math.max(0, rounded.bottomRight - innerFrame * 0.6),
          bottomLeft: Math.max(0, rounded.bottomLeft - innerFrame * 0.6)
        }
      );
      context.stroke();
    }

    context.save();
    traceRoundedRect(context, 0, 0, levelWidth, levelHeight, rounded);
    context.clip();

    const canvasW = this.canvas?.width && this.pixelRatio ? this.canvas.width / this.pixelRatio : Number.POSITIVE_INFINITY;
    const canvasH = this.canvas?.height && this.pixelRatio ? this.canvas.height / this.pixelRatio : Number.POSITIVE_INFINITY;
    const cullPad = 2;
    const minDrawX = Math.max(0, Math.floor(-screenOriginX / cellSize) - cullPad);
    const minVisY = Math.max(0, Math.floor(-screenOriginY / cellSize) - cullPad);
    const maxDrawX = Math.min(level.width, Math.ceil((canvasW - screenOriginX) / cellSize) + cullPad);
    const maxVisY = Math.min(level.height, Math.ceil((canvasH - screenOriginY) / cellSize) + cullPad);
    const minVisX = ticketFlipH ? Math.max(0, level.width - maxDrawX) : minDrawX;
    const maxVisX = ticketFlipH ? Math.min(level.width, level.width - minDrawX) : maxDrawX;

    if (!onlyAnimatedOverlay) for (let y = minVisY; y < maxVisY; y += 1) {
      for (let x = minVisX; x < maxVisX; x += 1) {
        const floor = level.floors[y][x];
        if (floor) {
          const drawX = resolveDrawCellX(level, x, ticketFlipH) * cellSize;
          this.drawFloor(floor, drawX, y * cellSize, cellSize, state);
        }
      }
    }

    if (!onlyAnimatedOverlay && (state.prefs.grid || state.drawStyle === "grid")) {
      context.strokeStyle = this.hsvToCssAlpha(scaffoldPalette.line.hue, scaffoldPalette.line.sat, clamp(scaffoldPalette.line.val * 0.92, 0, 1), 0.12);
      context.lineWidth = 1;
      for (let x = 1; x < level.width; x += 1) {
        context.beginPath();
        context.moveTo(x * cellSize, 0);
        context.lineTo(x * cellSize, level.height * cellSize);
        context.stroke();
      }
      for (let y = 1; y < level.height; y += 1) {
        context.beginPath();
        context.moveTo(0, y * cellSize);
        context.lineTo(level.width * cellSize, y * cellSize);
        context.stroke();
      }
    }

    const stillBlocks = [];
    const phantoms = skipAnimatedForBacking ? [] : getRenderPhantomsForLevel(animation, level);
    const movingBlocks = [];
    const smallMovingBlocks = [];
    // C# minDrawSize: skip blocks too small to see (screenHeight * 0.009 for normal style)
    const screenH = this.canvas?.height && this.pixelRatio ? this.canvas.height / this.pixelRatio : 600;
    const minDrawSize = Math.max(1, screenH * 0.009);
    for (let y = minVisY; y < maxVisY; y += 1) {
      for (let x = minVisX; x < maxVisX; x += 1) {
        const block = level.blocks[y][x];
        if (!block) {
          continue;
        }
        const simpleSlide = shouldSimpleSlide(parentBlock, block, animation, parents, state.drawStyle, depth);
        const transform = resolveAnimatedDrawTransform(block, animation, parentBlock, simpleSlide);
        // C# Draw.cs:5802 — skip blocks smaller than minDrawSize
        const blockW = cellSize * (transform?.scaleX ?? 1);
        const blockH = cellSize * (transform?.scaleY ?? 1);
        if (blockW < minDrawSize && blockH < minDrawSize) {
          continue;
        }
        const move = getAnimationMove(animation, block, animation?._moveByBlockId ?? null);
        const drawStart = move ? resolveMoveDrawStart(move) : null;
        const drawX = resolveDrawCellX(level, x, ticketFlipH) * cellSize;
        const item = { block, x: drawX, y: y * cellSize, simpleSlide, parents, ticketFlipH, screenOriginX, screenOriginY };
        const moving = transform && (
          Math.abs(transform.offsetX) > 0.0001 ||
          Math.abs(transform.offsetY) > 0.0001 ||
          Math.abs(transform.scaleX - 1) > 0.0001 ||
          Math.abs(transform.scaleY - 1) > 0.0001
        );
        if (skipAnimatedForBacking && moving) {
          continue;
        }
        if (onlyAnimatedOverlay && !moving) {
          continue;
        }
        if (moving && this._renderStats && onlyAnimatedOverlay) {
          this._renderStats.animationMovingOverlayBlocks += 1;
        }
        if (!moving) {
          stillBlocks.push(item);
        } else if ((drawStart?.scaleX ?? 1) < 1 || (drawStart?.scaleY ?? 1) < 1) {
          smallMovingBlocks.push(item);
        } else {
          movingBlocks.push(item);
        }
      }
    }
    const drawItemShadow = (item) => {
      const rect = resolveBlockDrawRect(item.block, item.x, item.y, cellSize, animation, parentBlock, item.simpleSlide, item.ticketFlipH);
      this.drawBlockShadow?.(item.block, rect.drawX, rect.drawY, rect.width, rect.height, item.ticketFlipH, cellSize, cellSize);
    };
    const drawPhantomShadow = (phantom) => {
      const transform = resolveRenderPhantomTransform(phantom, animation);
      const width = cellSize * transform.scaleX;
      const height = cellSize * transform.scaleY;
      if (width <= 0 || height <= 0) {
        return;
      }
      const phantomX = resolveDrawCellX(level, phantom.xpos, ticketFlipH);
      const centerX = phantomX * cellSize + cellSize / 2 + transform.offsetX * (ticketFlipH ? -1 : 1) * cellSize;
      const centerY = phantom.ypos * cellSize + cellSize / 2 + transform.offsetY * cellSize;
      this.drawBlockShadow?.(phantom.block, centerX - width / 2, centerY - height / 2, width, height, ticketFlipH, cellSize, cellSize);
    };
    this.beginShadowBatch();
    for (const queue of [stillBlocks, movingBlocks, smallMovingBlocks]) {
      for (const item of queue) {
        drawItemShadow(item);
      }
    }
    for (const phantom of phantoms) {
      drawPhantomShadow(phantom);
    }
    this.endShadowBatch();
    if (!onlyAnimatedOverlay) for (const item of stillBlocks) {
      this.drawBlock(
        state,
        item.block,
        item.x,
        item.y,
        cellSize,
        animation,
        depth,
        path,
        parentBlock,
        item.simpleSlide,
        item.parents,
        false,
        item.ticketFlipH,
        item.screenOriginX,
        item.screenOriginY
      );
    }
    for (const phantom of phantoms) {
      this.drawRenderPhantom(state, phantom, cellSize, animation, depth, path, parentBlock, parents, false, ticketFlipH, level, screenOriginX, screenOriginY);
    }
    for (const queue of [movingBlocks, smallMovingBlocks]) {
      for (const item of queue) {
        this.drawBlock(
          state,
          item.block,
          item.x,
          item.y,
          cellSize,
          animation,
          depth,
          path,
          parentBlock,
          item.simpleSlide,
          item.parents,
          false,
          item.ticketFlipH,
          item.screenOriginX,
          item.screenOriginY
        );
      }
    }

    context.restore();

    context.restore();
  }

  /**
   * @param {any} floor
   * @param {number} x
   * @param {number} y
   * @param {number} size
   */
  drawFloor(floor, x, y, size, state = null) {
    const context = this.context;
    const centerX = x + size / 2;
    const centerY = y + size / 2;
    const occupant = floor.outerLevel?.blocks?.[floor.ypos]?.[floor.xpos] ?? null;
    const buttonActive = Boolean(occupant && !occupant.isPlayer && occupant.subLevel);
    const playerButtonActive = Boolean(occupant && occupant.isPlayer && occupant.subLevel);
    const spriteInset = Math.max(1, size * 0.08);
    const spriteSize = Math.max(1, size - spriteInset * 2);

    if (floor.type === FloorType.BUTTON) {
      this.drawGoalFrame(floor, x, y, size, false, buttonActive, state);
      return;
    }
    if (floor.type === FloorType.PLAYER_BUTTON) {
      this.drawGoalFrame(floor, x, y, size, true, playerButtonActive, state);
      return;
    }
    if (floor.type === FloorType.LEVEL_PORTAL) {
      context.strokeStyle = "#7dd8f2";
      context.lineWidth = Math.max(2, size * 0.08);
      context.strokeRect(x + size * 0.2, y + size * 0.2, size * 0.6, size * 0.6);
      return;
    }
    if (floor.type === FloorType.INFO) {
      if (this.drawTexture("info", x + spriteInset, y + spriteInset, spriteSize, spriteSize)) {
        return;
      }
      context.fillStyle = "#f3f6f1";
      context.font = `${Math.max(10, size * 0.4)}px "Inconsolata Demake", monospace`;
      context.textAlign = "center";
      context.fillText("i", centerX, y + size * 0.66);
      return;
    }
    if (floor.type === FloorType.FAST_TRAVEL) {
      context.strokeStyle = "#c2ff80";
      context.lineWidth = 2;
      context.beginPath();
      context.moveTo(x + size * 0.2, centerY);
      context.lineTo(x + size * 0.8, centerY);
      context.moveTo(centerX, y + size * 0.2);
      context.lineTo(centerX, y + size * 0.8);
      context.stroke();
    }
  }

  /**
   * @param {number} originX
   * @param {number} width
   * @param {boolean} flipH
   * @param {() => void} draw
   */
  withHorizontalMirror(originX, width, flipH, draw) {
    const context = this.context;
    if (!flipH) {
      draw();
      return;
    }
    context.save();
    context.translate(originX * 2 + width, 0);
    context.scale(-1, 1);
    draw();
    context.restore();
  }

  /**
   * @param {any} block
   * @returns {boolean}
   */
  isSolidEdgeBlock(block) {
    return Boolean(block && block.kind === "wall" && !block.subLevel);
  }

  /**
   * Draw a room scaffold even when we do not recurse further.
   *
   * @param {any} level
   * @param {number} x
   * @param {number} y
   * @param {number} width
   * @param {number} height
   * @param {number} depth
   * @returns {{ originX: number, originY: number, cellSize: number, drawWidth: number, drawHeight: number }}
   */
  drawRoomScaffold(level, x, y, width, height, depth, ownerBlock = null) {
    const context = this.context;
    const pixelStep = this.pixelRatio ? 1 / this.pixelRatio : 1;
    const viewport = computeLevelViewport(level, x, y, width, height, 0, 0.5, pixelStep);
    const palette = this.computeScaffoldPalette(ownerBlock, viewport.drawWidth, viewport.drawHeight);
    const mask = computeLevelWallMask(level);
    const radius = Math.max(2, viewport.cellSize * 0.22);
    const rounded = {
      topLeft: mask.leftWall && mask.upWall ? radius : 0,
      topRight: mask.rightWall && mask.upWall ? radius : 0,
      bottomRight: mask.rightWall && mask.downWall ? radius : 0,
      bottomLeft: mask.leftWall && mask.downWall ? radius : 0
    };
    const frameTone = this.hsvToCssAlpha(
      palette.fill.hue,
      clamp(palette.fill.sat * 0.7, 0, 1),
      clamp(palette.fill.val * (depth <= 1 ? 0.35 : 0.28), 0, 1),
      0.86
    );
    const frameColor = this.hsvToCssAlpha(palette.line.hue, palette.line.sat, palette.line.val, depth <= 1 ? 0.72 : 0.6);
    const innerGlow = this.hsvToCssAlpha(
      palette.fill.hue,
      clamp(palette.fill.sat * 0.72, 0, 1),
      clamp(palette.fill.val * 1.18, 0, 1),
      depth <= 1 ? 0.15 : 0.1
    );
    const cellSize = viewport.cellSize;
    const wallThickness = Math.max(1, Math.min(3, cellSize * 0.11));
    const scaffoldInset = Math.max(1, cellSize * 0.06);

    context.fillStyle = frameTone;
    traceRoundedRect(context, viewport.originX, viewport.originY, viewport.drawWidth, viewport.drawHeight, rounded);
    context.fill();

    context.fillStyle = this.hsvToCssAlpha(
      palette.fill.hue,
      clamp(palette.fill.sat * 0.9, 0, 1),
      clamp(palette.fill.val * 1.05, 0, 1),
      depth <= 1 ? 0.18 : 0.12
    );
    traceRoundedRect(context, viewport.originX, viewport.originY, viewport.drawWidth, viewport.drawHeight, rounded);
    context.fill();

    context.fillStyle = innerGlow;
    traceRoundedRect(
      context,
      viewport.originX + scaffoldInset,
      viewport.originY + scaffoldInset,
      Math.max(0, viewport.drawWidth - scaffoldInset * 2),
      Math.max(0, viewport.drawHeight - scaffoldInset * 2),
      {
        topLeft: Math.max(0, rounded.topLeft - scaffoldInset),
        topRight: Math.max(0, rounded.topRight - scaffoldInset),
        bottomRight: Math.max(0, rounded.bottomRight - scaffoldInset),
        bottomLeft: Math.max(0, rounded.bottomLeft - scaffoldInset)
      }
    );
    context.fill();

    context.strokeStyle = frameColor;
    context.lineWidth = Math.max(1, cellSize * 0.08);
    traceRoundedRect(context, viewport.originX, viewport.originY, viewport.drawWidth, viewport.drawHeight, rounded);
    context.stroke();

    context.save();
    traceRoundedRect(context, viewport.originX, viewport.originY, viewport.drawWidth, viewport.drawHeight, rounded);
    context.clip();

    if (cellSize >= 6) {
      context.strokeStyle = this.hsvToCssAlpha(palette.line.hue, palette.line.sat, clamp(palette.line.val * 0.96, 0, 1), 0.12);
      context.lineWidth = 1;
      for (let xIndex = 1; xIndex < level.width; xIndex += 1) {
        const lineX = viewport.originX + xIndex * cellSize;
        context.beginPath();
        context.moveTo(lineX, viewport.originY);
        context.lineTo(lineX, viewport.originY + viewport.drawHeight);
        context.stroke();
      }
      for (let yIndex = 1; yIndex < level.height; yIndex += 1) {
        const lineY = viewport.originY + yIndex * cellSize;
        context.beginPath();
        context.moveTo(viewport.originX, lineY);
        context.lineTo(viewport.originX + viewport.drawWidth, lineY);
        context.stroke();
      }
    }

    if (cellSize >= 5) {
      const edgeColor = this.hsvToCssAlpha(palette.wall.hue, palette.wall.sat, palette.wall.val, 0.22);
      context.fillStyle = edgeColor;
      for (let yIndex = 0; yIndex < level.height; yIndex += 1) {
        if (this.isSolidEdgeBlock(level.blocks[yIndex]?.[0])) {
          context.fillRect(viewport.originX, viewport.originY + yIndex * cellSize, wallThickness, cellSize);
        }
        if (this.isSolidEdgeBlock(level.blocks[yIndex]?.[level.width - 1])) {
          context.fillRect(
            viewport.originX + viewport.drawWidth - wallThickness,
            viewport.originY + yIndex * cellSize,
            wallThickness,
            cellSize
          );
        }
      }
      for (let xIndex = 0; xIndex < level.width; xIndex += 1) {
        if (this.isSolidEdgeBlock(level.blocks[0]?.[xIndex])) {
          context.fillRect(viewport.originX + xIndex * cellSize, viewport.originY, cellSize, wallThickness);
        }
        if (this.isSolidEdgeBlock(level.blocks[level.height - 1]?.[xIndex])) {
          context.fillRect(
            viewport.originX + xIndex * cellSize,
            viewport.originY + viewport.drawHeight - wallThickness,
            cellSize,
            wallThickness
          );
        }
      }
    }

    context.restore();

    return viewport;
  }

  /**
   * @param {any} block
   * @param {number} x
   * @param {number} y
   * @param {number} width
   * @param {number} height
   */
  drawInfinityEffect(block, x, y, width, height) {
    const key = block.isSomeInfEnterBlock ? "infParticleOutline" : "infParticle";
    const texture = this.getTexture(key);
    const count = computeInfinitySymbolCount(block);
    if (!texture || count <= 0) {
      return;
    }

    const screenFraction = this.getFractionOfScreen(width, height);
    const alpha = clamp(-Math.log10(screenFraction + 0.35) + 0.34, 0.24, 1);
    const centerX = x + width / 2;
    const centerY = y + height / 2;

    if (count === 1) {
      const symbolWidth = width * 0.96;
      const symbolHeight = height * 0.96;
      this.drawTexture(key, centerX - symbolWidth / 2, centerY - symbolHeight / 2, symbolWidth, symbolHeight, alpha);
      return;
    }

    const stepWidth = width / (count + 1);
    const stepHeight = height / (count + 1);
    const gap = (height - stepHeight * count) / (count + 1);
    const symbolWidth = stepWidth * 1.95;
    const symbolHeight = stepHeight * 1.95;
    let drawY = centerY - symbolHeight / 2 - (stepHeight / 2 + gap / 2) * (count - 1);
    const drawX = centerX - symbolWidth / 2;
    for (let index = 0; index < count; index += 1) {
      this.drawTexture(key, drawX, drawY, symbolWidth, symbolHeight, alpha);
      drawY += stepHeight + gap;
    }
  }

  /**
   * @param {any} block
   * @param {number} x
   * @param {number} y
   * @param {number} width
   * @param {number} height
   * @param {boolean} [flipH]
   */
  drawFlipShine(block, x, y, width, height, flipH = false) {
    const intensity = resolveFlipIntensity(block);
    if (intensity <= 0 || block?.subLevel?.filledWithWalls) {
      return;
    }
    const context = this.context;
    const screenFraction = this.getFractionOfScreen(width, height);
    const alpha = Math.min(0.22, Math.max(0.04, -Math.log10(screenFraction + 0.5) + 0.18)) * intensity;
    const reverse = Boolean(flipH || block.specialEffect === 3);
    const gradient = context.createLinearGradient(reverse ? x + width : x, y, reverse ? x : x + width, y);
    gradient.addColorStop(0, "rgba(255,255,255,0)");
    gradient.addColorStop(0.3, "rgba(255,255,255,0)");
    gradient.addColorStop(0.5, `rgba(255,255,255,${alpha})`);
    gradient.addColorStop(0.7, "rgba(255,255,255,0)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    const prevFillStyle = context.fillStyle;
    context.fillStyle = gradient;
    context.fillRect(x, y, width, height);
    context.fillStyle = prevFillStyle;
  }

  /**
   * @param {any} level
   * @param {number} x
   * @param {number} y
   * @param {number} width
   * @param {number} height
   * @param {number} depth
   * @param {boolean} [flipH]
   */
  drawCompactLevelPreview(level, x, y, width, height, depth, flipH = false) {
    if (this._renderStats) {
      this._renderStats.drawCompactLevelPreview += 1;
    }
    if (width < MIN_COMPACT_NESTED_SIZE || height < MIN_COMPACT_NESTED_SIZE) {
      return;
    }
    const context = this.context;
    const pixelStep = this.pixelRatio ? 1 / this.pixelRatio : 1;
    const viewport = computeLevelViewport(level, x, y, width, height, 0, 0.5, pixelStep);
    const previewX = viewport.originX;
    const previewY = viewport.originY;
    const cellSize = viewport.cellSize;
    const inset = Math.max(1, cellSize * 0.12);
    const canvasW = this.canvas?.width && this.pixelRatio ? this.canvas.width / this.pixelRatio : Number.POSITIVE_INFINITY;
    const canvasH = this.canvas?.height && this.pixelRatio ? this.canvas.height / this.pixelRatio : Number.POSITIVE_INFINITY;
    const cullPad = 1;
    const minDrawX = Math.max(0, Math.floor(-previewX / cellSize) - cullPad);
    const minVisY = Math.max(0, Math.floor(-previewY / cellSize) - cullPad);
    const maxDrawX = Math.min(level.width, Math.ceil((canvasW - previewX) / cellSize) + cullPad);
    const maxVisY = Math.min(level.height, Math.ceil((canvasH - previewY) / cellSize) + cullPad);
    const minVisX = flipH ? Math.max(0, level.width - maxDrawX) : minDrawX;
    const maxVisX = flipH ? Math.min(level.width, level.width - minDrawX) : maxDrawX;
    const drawTexturedWalls = cellSize >= MIN_TEXTURED_COMPACT_CELL_SIZE;

    context.save();
    for (let yIndex = minVisY; yIndex < maxVisY; yIndex += 1) {
      for (let xIndex = minVisX; xIndex < maxVisX; xIndex += 1) {
        const floor = level.floors[yIndex][xIndex];
        if (!floor) {
          continue;
        }
        const floorX = previewX + resolveDrawCellX(level, xIndex, flipH) * cellSize;
        this.drawFloor(floor, floorX, previewY + yIndex * cellSize, cellSize, null);
      }
    }

    for (let yIndex = minVisY; yIndex < maxVisY; yIndex += 1) {
      for (let xIndex = minVisX; xIndex < maxVisX; xIndex += 1) {
        const block = level.blocks[yIndex][xIndex];
        if (!block) {
          continue;
        }
        const blockX = previewX + resolveDrawCellX(level, xIndex, flipH) * cellSize;
        const blockY = previewY + yIndex * cellSize;
        if (block.kind === "wall") {
          if (drawTexturedWalls) {
            this.drawWallBlock(block, blockX, blockY, cellSize, cellSize >= 9, true, flipH);
          } else {
            const ownerBlock = resolveLevelOwnerBlock(block.outerLevel);
            const wallHsv = this.computeWallHsv(ownerBlock, cellSize, cellSize);
            context.fillStyle = this.hsvToCssAlpha(wallHsv.hue, wallHsv.sat, wallHsv.val, 1);
            context.fillRect(blockX, blockY, Math.max(1, cellSize), Math.max(1, cellSize));
          }
          continue;
        }
        const blockTicketFlipH = resolveBlockTicketFlipH(flipH, block);
        const surfaceWidth = Math.max(1, cellSize - inset * 2);
        const surfaceHeight = Math.max(1, cellSize - inset * 2);
        const fillHsv = this.computeBlockHsv(block, surfaceWidth, surfaceHeight);
        const lineHsv = this.computeLineHsv(block, surfaceWidth, surfaceHeight, false);
        this.drawColorBlockSurface(blockX + inset, blockY + inset, surfaceWidth, surfaceHeight, fillHsv, lineHsv, {
          addShadow: false
        });

        let infWindow = {
          x: blockX + inset,
          y: blockY + inset,
          width: Math.max(1, cellSize - inset * 2),
          height: Math.max(1, cellSize - inset * 2)
        };
        if (shouldRenderNestedInterior(block) && cellSize >= 8) {
          infWindow = this.drawNestedShell(block, blockX + inset, blockY + inset, surfaceWidth, surfaceHeight, depth + 1);
        }

        if (cellSize >= 6) {
          this.drawFlipShine(block, blockX + inset, blockY + inset, Math.max(1, cellSize - inset * 2), Math.max(1, cellSize - inset * 2), blockTicketFlipH);
        }

        if (cellSize >= 6 && shouldDrawInfinityEffect(block)) {
          const target = block.subLevel?.infZone ? infWindow : {
            x: blockX + inset,
            y: blockY + inset,
            width: Math.max(1, cellSize - inset * 2),
            height: Math.max(1, cellSize - inset * 2)
          };
          this.drawInfinityEffect(block, target.x, target.y, target.width, target.height);
        }

        if (block.isPlayer && cellSize >= 9) {
          this.drawFace(block, blockX + inset, blockY + inset, Math.max(1, cellSize - inset * 2), Math.max(1, cellSize - inset * 2), blockTicketFlipH !== Boolean(block.flipH));
        }
      }
    }

    context.restore();
  }

  /**
   * @param {any} state
   * @param {any} block
   * @param {number} x
   * @param {number} y
   * @param {number} size
   * @param {any} animation
   * @param {number} depth
   * @param {Set<number>} [path]
   * @param {any | null} [parentBlock]
   * @param {boolean} [simpleSlide]
   * @param {Array<any>} [parents]
   * @param {boolean} [drawShadow]
   * @param {boolean} [parentTicketFlipH]
   * @param {number} [levelScreenOriginX]
   * @param {number} [levelScreenOriginY]
   */
  drawBlock(
    state,
    block,
    x,
    y,
    size,
    animation,
    depth,
    path = new Set(),
    parentBlock = null,
    simpleSlide = false,
    parents = [],
    drawShadow = true,
    parentTicketFlipH = false,
    levelScreenOriginX = 0,
    levelScreenOriginY = 0
  ) {
    return this.drawBlockInternal(
      state,
      block,
      x,
      y,
      size,
      animation,
      depth,
      path,
      parentBlock,
      simpleSlide,
      parents,
      drawShadow,
      parentTicketFlipH,
      levelScreenOriginX,
      levelScreenOriginY
    );
  }

  /**
   * @param {any} state
   * @param {any} block
   * @param {number} x
   * @param {number} y
   * @param {number} size
   * @param {any} animation
   * @param {number} depth
   * @param {Set<number>} path
   * @param {any | null} [parentBlock]
   * @param {boolean} [simpleSlide]
   * @param {Array<any>} [parents]
   * @param {boolean} [drawShadow]
   * @param {boolean} [parentTicketFlipH]
   * @param {number} [levelScreenOriginX]
   * @param {number} [levelScreenOriginY]
   */
  drawBlockInternal(
    state,
    block,
    x,
    y,
    size,
    animation,
    depth,
    path,
    parentBlock = null,
    simpleSlide = false,
    parents = [],
    drawShadow = true,
    parentTicketFlipH = false,
    levelScreenOriginX = 0,
    levelScreenOriginY = 0
  ) {
    const rect = resolveBlockDrawRect(block, x, y, size, animation, parentBlock, simpleSlide, parentTicketFlipH);
    const ticketFlipH = resolveBlockTicketFlipH(parentTicketFlipH, block);
    this.drawBlockRect(
      state,
      block,
      rect.drawX,
      rect.drawY,
      rect.width,
      rect.height,
      size,
      animation,
      depth,
      path,
      parentBlock,
      simpleSlide,
      parents,
      ticketFlipH,
      drawShadow,
      levelScreenOriginX,
      levelScreenOriginY
    );
  }

  /**
   * @param {any} state
   * @param {any} block
   * @param {number} drawX
   * @param {number} drawY
   * @param {number} width
   * @param {number} height
   * @param {number} staticSize
   * @param {any} animation
   * @param {number} depth
   * @param {Set<number>} path
   * @param {any | null} parentBlock
   * @param {boolean} simpleSlide
   * @param {Array<any>} parents
   * @param {boolean} flipH
   * @param {boolean} [drawShadow]
   * @param {number} [levelScreenOriginX]
   * @param {number} [levelScreenOriginY]
   */
  drawBlockRect(
    state,
    block,
    drawX,
    drawY,
    width,
    height,
    staticSize,
    animation,
    depth,
    path,
    parentBlock,
    simpleSlide,
    parents,
    flipH,
    drawShadow = true,
    levelScreenOriginX = 0,
    levelScreenOriginY = 0
  ) {
    if (this._renderStats) {
      this._renderStats.drawBlockRect += 1;
    }
    const context = this.context;
    const canvasPixelW = this.canvas?.width || 0;
    const canvasPixelH = this.canvas?.height || 0;
    const screenW = canvasPixelW && this.pixelRatio ? canvasPixelW / this.pixelRatio : 0;
    const screenH = canvasPixelH && this.pixelRatio ? canvasPixelH / this.pixelRatio : 0;

    let clipLeft = drawX;
    let clipTop = drawY;
    let clipRight = drawX + width;
    let clipBottom = drawY + height;
    let hasClip = false;

    // Large enter/exit blocks can span far outside the viewport. Clip only the
    // block shell/body pass; nested contents are drawn after restoring this clip
    // so their own level-space clipping remains correct.
    if (screenW > 0 && screenH > 0 && width > screenW * 1.5 && height > screenH * 1.5) {
      const transform = context.getTransform();
      const invA = transform.a !== 0 ? 1 / transform.a : 1;
      const invD = transform.d !== 0 ? 1 / transform.d : 1;
      const visibleLeft = -transform.e * invA;
      const visibleTop = -transform.f * invD;
      const visibleRight = visibleLeft + canvasPixelW * invA;
      const visibleBottom = visibleTop + canvasPixelH * invD;

      clipLeft = Math.max(drawX, visibleLeft);
      clipTop = Math.max(drawY, visibleTop);
      clipRight = Math.min(drawX + width, visibleRight);
      clipBottom = Math.min(drawY + height, visibleBottom);

      if (clipRight <= clipLeft || clipBottom <= clipTop) {
        return;
      }
      hasClip = true;
    }

    if (block.kind === "wall") {
      if (hasClip) {
        context.save();
        context.beginPath();
        context.rect(clipLeft, clipTop, clipRight - clipLeft, clipBottom - clipTop);
        context.clip();
      }
      if (drawShadow) {
        this.drawBlockShadow?.(block, drawX, drawY, width, height, flipH, staticSize, staticSize);
      }
      this.drawWallBlock(block, drawX, drawY, width, height, true, flipH);
      if (hasClip) {
        context.restore();
      }
      return;
    }

    const fillHsv = this.computeBlockHsv(block, width, height);
    const lineHsv = this.computeLineHsv(block, width, height, false);
    const hasNested = shouldRenderNestedInterior(block);

    if (hasClip) {
      context.save();
      context.beginPath();
      context.rect(clipLeft, clipTop, clipRight - clipLeft, clipBottom - clipTop);
      context.clip();
    }

    if (drawShadow) {
      this.drawBlockShadow?.(block, drawX, drawY, width, height, flipH, staticSize, staticSize);
    }
    // C# block body is at alpha 0.5 (HSVToRGBGUI). For nested blocks, reduce
    // body opacity so empty cells in the sub-level show through at reduced brightness.
    this.drawColorBlockSurface(drawX, drawY, width, height, fillHsv, lineHsv, { bodyAlpha: hasNested ? 0.65 : 1 });
    this.drawBlockBorder(block, drawX, drawY, width, height, staticSize, lineHsv, flipH);

    let nestedWindow = null;
    let stableNestedWindow = null;
    if (hasNested) {
      nestedWindow = this.drawNestedShell(block, drawX, drawY, width, height, depth);
      // Animation-backing debug: keep a stable local window available so
      // animated nested rooms can reuse one static backing image instead of
      // full-direct rendering every animation frame. Non-animation frames still
      // behave like the baseline unless drawNestedLevelCached decides otherwise.
      stableNestedWindow = this.computeNestedShellWindow(block, 0, 0, staticSize, staticSize, depth);
    }

    if (hasClip) {
      context.restore();
    }

    const nestedPreviewSize = nestedWindow ? Math.min(nestedWindow.width, nestedWindow.height) : 0;
    const shouldExpandNested = !this._skipNested && nestedWindow && shouldDrawNestedLevel(block, depth, path, nestedPreviewSize);
    let drewNestedLevel = false;
    if (shouldExpandNested) {
      drewNestedLevel = this.drawNestedLevelCached(
        state,
        block,
        nestedWindow,
        stableNestedWindow,
        animation,
        depth + 1,
        path,
        parentBlock,
        parents,
        flipH,
        levelScreenOriginX,
        levelScreenOriginY
      );
    }
    if (nestedWindow && !drewNestedLevel) {
      const compactCount = this._compactPreviewCount ?? 0;
      if (shouldDrawCompactNestedLevel(block, depth, path, nestedPreviewSize, compactCount)) {
        this._compactPreviewCount = compactCount + 1;
        this.drawCompactLevelPreview(block.subLevel, nestedWindow.x, nestedWindow.y, nestedWindow.width, nestedWindow.height, depth + 1, flipH);
      } else if (this._renderStats) {
        this._renderStats.shellFallbacks += 1;
        this._renderStats.skippedTiny += 1;
      }
    }

    if (nestedWindow && width <= 512 && height <= 512) {
      // Re-apply center gradient on top of nested shell so the vignette stays visible.
      this.drawTexture("blockGradient", drawX, drawY, width, height, 0.06);
    }

    this.drawFlipShine(block, drawX, drawY, width, height, flipH);

    if (shouldDrawInfinityEffect(block)) {
      const target = block.subLevel?.infZone && nestedWindow
        ? nestedWindow
        : { x: drawX, y: drawY, width, height };
      this.drawInfinityEffect(block, target.x, target.y, target.width, target.height);
    }

    if (block.isPlayer || block.possessable) {
      this.drawFace(block, drawX, drawY, width, height, flipH !== Boolean(block.flipH));
    }
  }

  /**
   * @param {any} state
   * @param {any} phantom
   * @param {number} cellSize
   * @param {any} animation
   * @param {number} depth
   * @param {Set<number>} path
   * @param {any | null} parentBlock
   * @param {Array<any>} parents
   * @param {boolean} [drawShadow]
   * @param {boolean} [parentTicketFlipH]
   * @param {any | null} [level]
   * @param {number} [levelScreenOriginX]
   * @param {number} [levelScreenOriginY]
   */
  drawRenderPhantom(
    state,
    phantom,
    cellSize,
    animation,
    depth,
    path,
    parentBlock,
    parents,
    drawShadow = true,
    parentTicketFlipH = false,
    level = null,
    levelScreenOriginX = 0,
    levelScreenOriginY = 0
  ) {
    const transform = resolveRenderPhantomTransform(phantom, animation);
    const width = cellSize * transform.scaleX;
    const height = cellSize * transform.scaleY;
    if (width <= 0 || height <= 0) {
      return;
    }
    const drawXpos = level ? resolveDrawCellX(level, phantom.xpos, parentTicketFlipH) : phantom.xpos;
    const centerX = drawXpos * cellSize + cellSize / 2 + transform.offsetX * (parentTicketFlipH ? -1 : 1) * cellSize;
    const centerY = phantom.ypos * cellSize + cellSize / 2 + transform.offsetY * cellSize;
    const drawX = centerX - width / 2;
    const drawY = centerY - height / 2;
    const phantomFlipH = resolvePhantomTicketFlipH(parentTicketFlipH, phantom.block);
    this.drawBlockRect(
      state,
      phantom.block,
      drawX,
      drawY,
      width,
      height,
      cellSize,
      null,
      depth,
      path,
      parentBlock,
      false,
      parents,
      phantomFlipH,
      drawShadow,
      levelScreenOriginX,
      levelScreenOriginY
    );
  }

  /**
   * @param {any} block
   * @param {number} x
   * @param {number} y
   * @param {number} width
   * @param {number} height
   * @param {boolean} flipH
   */
  drawFace(block, x, y, width, height, flipH) {
    const context = this.context;
    const cx = x + width / 2;
    const cy = y + height / 2;
    const faceActive = Boolean(block.drawIsPlayer || block.isPlayer);
    const small = width * 0.2 < 50;
    let alpha = -Math.log10(this.getFractionOfScreen(width, height) + (block.subLevel && !block.subLevel.filledWithWalls ? 1.5 : 15)) +
      (block.subLevel && !block.subLevel.filledWithWalls ? 0.5 : 1.5);
    alpha = clamp(alpha, faceActive ? 0.45 : 0.35, faceActive ? 0.92 : 0.82);
    const tintCss = "rgb(0 0 0)";

    const eyeKey = faceActive
      ? (small ? "eyeLeft" : "eyeLeftLarge")
      : (small ? "possessEye" : "possessEyeLarge");
    const eyeWidth = Math.max(3, width * 0.2);
    const eyeHeight = Math.max(3, height * 0.2);
    let leftEyeOffset = -0.25;
    let rightEyeOffset = 0.25;
    let leftEyeY = -0.05;
    let rightEyeY = -0.05;
    if (flipH) {
      leftEyeOffset *= -1;
      rightEyeOffset *= -1;
    }

    this.drawTextureTinted(
      eyeKey,
      cx + width * leftEyeOffset - eyeWidth / 2,
      cy + height * leftEyeY - eyeHeight / 2,
      eyeWidth,
      eyeHeight,
      tintCss,
      alpha
    );
    this.drawTextureTinted(
      eyeKey,
      cx + width * rightEyeOffset - eyeWidth / 2,
      cy + height * rightEyeY - eyeHeight / 2,
      eyeWidth,
      eyeHeight,
      tintCss,
      alpha
    );

    if (!faceActive || block.playerOrder <= 0) {
      return;
    }

    const mouthMap = {
      1: flipH ? "mouthFrownyFlip" : "mouthFrowny",
      3: "mouthV",
      4: flipH ? "mouthMehFlip" : "mouthMeh",
      5: flipH ? "mouthOpenFlip" : "mouthOpen"
    };
    const mouthKey = block.playerOrder >= 6 ? (flipH ? "mouthSquareFlip" : "mouthSquare") : mouthMap[block.playerOrder] ?? null;
    let mouthXOffset = 0;
    let mouthYOffset = 0.15;
    let mouthWidth = width * 0.25;
    let mouthHeight = height * 0.25;

    if (block.playerOrder === 1) {
      mouthXOffset = -0.01;
    } else if (block.playerOrder === 2) {
      mouthWidth = width * 0.2666;
      mouthHeight = height * 0.05;
      mouthYOffset = 0.17;
    } else if (block.playerOrder === 4) {
      mouthYOffset = 0.17;
    }
    if (flipH) {
      mouthXOffset *= -1;
    }

    if (block.playerOrder === 2) {
      context.save();
      context.globalAlpha = alpha;
      context.fillStyle = tintCss;
      context.fillRect(
        cx + width * mouthXOffset - mouthWidth / 2,
        cy + height * mouthYOffset - mouthHeight / 2,
        mouthWidth,
        mouthHeight
      );
      context.restore();
      return;
    }

    if (mouthKey) {
      this.drawTextureTinted(
        mouthKey,
        cx + width * mouthXOffset - mouthWidth / 2,
        cy + height * mouthYOffset - mouthHeight / 2,
        mouthWidth,
        mouthHeight,
        tintCss,
        alpha
      );
    }
  }

  /**
   * @param {number} width
   * @param {number} height
   * @param {string} text
   */
  drawInfo(width, height, text) {
    const context = this.context;
    const padding = 18;
    const boxWidth = Math.min(width - 40, 520);
    const boxHeight = 76;
    const x = (width - boxWidth) / 2;
    const y = height - boxHeight - 18;
    context.fillStyle = "rgba(9, 16, 21, 0.9)";
    context.fillRect(x, y, boxWidth, boxHeight);
    context.strokeStyle = "#4f6a75";
    context.lineWidth = 2;
    context.strokeRect(x, y, boxWidth, boxHeight);
    context.fillStyle = "#f3f6f1";
    context.font = '600 16px "Inconsolata Demake", monospace';
    context.textAlign = "left";
    const lines = text.split("\n");
    lines.slice(0, 3).forEach((line, index) => {
      context.fillText(line, x + padding, y + padding + 18 + index * 18);
    });
  }
}

import { FloorType, getExitBlock } from "../core/model.js";
import { clamp, hsvToRgb, lerp } from "../parser/invariant.js";

export const MAX_SUBLEVEL_RENDER_DEPTH = 4;
export const MIN_EXPANDED_NESTED_SIZE = 48;

export const ENTER_LENGTH = 0.5;
export const TRANSFER_LENGTH = 0.2;

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

  context.save();
  context.globalAlpha = drawAlpha;
  context.imageSmoothingEnabled = true;
  context.drawImage(tintSurface.canvas, 0, 0, tintSurface.width, tintSurface.height, x, y, width, height);
  context.restore();
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

  context.save();
  context.imageSmoothingEnabled = imageSmoothing;
  context.drawImage(tintSurface.canvas, 0, 0, tintSurface.width, tintSurface.height, x, y, width, height);
  context.restore();
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
  const move = animation?.turn?.moves?.find?.((entry) => entry.block?.id === childBlock.id) ?? null;
  const animKind = move?.animKind ?? (move?.trail?.some?.((step) => step.moveType === "Enter" || step.moveType === "Exit") ? "ENTER_EXIT" : "NORMAL");
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
  const move = animation?.turn?.moves?.find?.((entry) => entry.block?.id === block.id) ?? null;
  if (!move) {
    return null;
  }
  const progress = clamp(animation?.progress ?? 1, 0, 1);
  const reverse = animation?.direction === "reverse";
  const hasEnterExitTrail = move.trail?.some?.((step) => step.moveType === "Enter" || step.moveType === "Exit");

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

  if (parentBlock && block.justEnteredArray?.[0] === parentBlock) {
    const parentMove = animation?.turn?.moves?.find?.((entry) => entry.block?.id === parentBlock.id) ?? null;
    const parentStart = parentMove ? resolveMoveDrawStart(parentMove) : null;
    if (parentStart) {
      const parentScaleX = lerp(parentStart.scaleX, 1, progress);
      const parentScaleY = lerp(parentStart.scaleY, 1, progress);
      if (parentScaleX !== 0) {
        startScaleX /= parentScaleX;
      }
      if (parentScaleY !== 0) {
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
  return (animation?.turn?.renderPhantoms ?? []).filter((phantom) => phantom.outerLevel === level);
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
 * @returns {{ drawX: number, drawY: number, width: number, height: number }}
 */
function resolveBlockDrawRect(block, x, y, size, animation, parentBlock = null, simpleSlide = false) {
  const animatedTransform = resolveAnimatedDrawTransform(block, animation, parentBlock, simpleSlide);
  const scaleX = animatedTransform?.scaleX ?? 1;
  const scaleY = animatedTransform?.scaleY ?? 1;
  const width = size * scaleX;
  const height = size * scaleY;
  const centerX = x + size / 2 + (animatedTransform?.offsetX ?? 0) * size;
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
  if (!block?.subLevel) {
    return false;
  }
  if (depth >= maxDepth) {
    return false;
  }
  if (previewSize < 36) {
    return false;
  }
  return !path?.has(block.subLevel.id);
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
    this.wallBigQuads = null;
    this.wallBigDataLoadStarted = false;
    this.cameraFlipH = false;
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
    } catch {
      this._spriteSheet = null;
      this._spriteManifest = null;
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
    const img = new Image();
    img.src = off.toDataURL();
    return img;
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
      })
      .catch(() => {
        this.wallBigQuads = null;
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
    context.save();
    context.globalAlpha = clamp(alpha, 0, 1);
    context.imageSmoothingEnabled = true;
    context.drawImage(texture, x, y, width, height);
    context.restore();
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
    context.save();
    context.globalAlpha = clamp(alpha, 0, 1);
    context.imageSmoothingEnabled = true;
    context.drawImage(texture, x, y, width, height);
    context.restore();
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
    const texture = this.getTextureFile(filename);
    if (!texture) {
      return false;
    }
    drawModulatedTexture(this, texture, x, y, width, height, tintRgb, alpha, imageSmoothing, flipY, flipX);
    return true;
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const pixelRatio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.floor(rect.width * pixelRatio));
    const height = Math.max(1, Math.floor(rect.height * pixelRatio));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.pixelRatio = pixelRatio;
    this.context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
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
      this.drawTexture("blockGradient", x, y, width, height, 0.08);
    } else {
      context.globalAlpha = bodyAlpha;
      context.fillStyle = this.linearRgbToCss(fillRgb);
      context.fillRect(x, y, width, height);
      context.globalAlpha = 1;
      this.drawTexture("blockGradient", x, y, width, height, 0.08 * bodyAlpha);
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
   */
  drawBlockBorder(block, x, y, width, height, staticSize, lineHsv) {
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

    if (!mask || mask.upWall) {
      context.fillRect(x, y, width, thickness);
    }
    if (!mask || mask.downWall) {
      context.fillRect(x, y + height - thickness, width, thickness);
    }
    if (!mask || mask.leftWall) {
      context.fillRect(x, y, thickness, height);
    }
    if (!mask || mask.rightWall) {
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
    const context = this.context;
    const screenWidth = this.canvas?.width && this.pixelRatio ? this.canvas.width / this.pixelRatio : staticWidth;
    const screenHeight = this.canvas?.height && this.pixelRatio ? this.canvas.height / this.pixelRatio : staticHeight;
    const { offsetX, offsetY } = computeBlockShadowOffset(width, height, block, flipH, staticWidth, staticHeight, screenWidth, screenHeight);

    context.save();
    context.globalAlpha = 0.15;
    if (block.kind === "wall") {
      const wallIndex = computeWallTileIndex(block, flipH);
      if (!this.drawWallTexture(block, wallIndex, x + offsetX, y + offsetY, width, height, { r: 0, g: 0, b: 0 }, flipH)) {
        context.fillStyle = "rgb(0 0 0)";
        context.fillRect(x + offsetX, y + offsetY, width, height);
      }
    } else {
      context.fillStyle = "rgb(0 0 0)";
      context.fillRect(x + offsetX, y + offsetY, width, height);
    }
    context.restore();
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
    const context = this.context;
    const window = { x, y, width, height };

    // Dark scrim inside nested rooms — empty cells should feel shadowed.
    // C# body at alpha 0.5 naturally darkens gaps; we approximate with a
    // subtle dark fill that doesn't distort wall texture colors.
    context.save();
    context.fillStyle = "rgba(0, 0, 0, 0.18)";
    context.fillRect(x, y, width, height);
    context.restore();

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

    context.save();
    if (!this.drawWallTexture(block, wallIndex, x, y, width, height, tintRgb, flipH)) {
      context.fillStyle = this.rgbToCss(tintRgb, 1);
      context.fillRect(x, y, width, height);
    }
    context.restore();

    if (drawFace && (block.isPlayer || block.possessable)) {
      this.drawFace(block, x, y, width, height, flipH !== Boolean(block.flipH));
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
   * @param {any} state
   * @param {{ animation?: any, infoText?: string | null, emptyText?: string | null }} [options]
   */
  render(state, options = {}) {
    const context = this.context;
    const width = this.canvas.width / this.pixelRatio;
    const height = this.canvas.height / this.pixelRatio;

    context.clearRect(0, 0, width, height);
    context.fillStyle = "#091015";
    context.fillRect(0, 0, width, height);

    if (!state?.focusBlock?.outerLevel) {
      this.drawEmpty(width, height, options.emptyText ?? "点击左侧关卡开始");
      return;
    }

    const animation = options.animation ?? null;
    const focusLevel = state.focusBlock.outerLevel;
    const pixelStep = this.pixelRatio ? 1 / this.pixelRatio : 1;
    const viewport = computeLevelViewport(focusLevel, 0, 0, width, height, 24, 4, pixelStep);
    this.drawLevel(state, focusLevel, viewport.originX, viewport.originY, viewport.cellSize, animation, 0, new Set([focusLevel.id]));

    if (options.infoText) {
      this.drawInfo(width, height, options.infoText);
    }
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

    this.drawLevel(state, level, originX, originY, cellSize, null, 0, new Set([level.id]));

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
  drawLevel(state, level, originX, originY, cellSize, animation, depth, path = new Set([level.id]), parentBlock = null, parents = []) {
    return this.drawLevelInternal(state, level, originX, originY, cellSize, animation, depth, path, parentBlock, parents);
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
   */
  drawLevelInternal(state, level, originX, originY, cellSize, animation, depth, path, parentBlock = null, parents = []) {
    const context = this.context;
    const levelWidth = level.width * cellSize;
    const levelHeight = level.height * cellSize;
    const ownerBlock = parentBlock ?? resolveLevelOwnerBlock(level);
    const scaffoldPalette = this.computeScaffoldPalette(ownerBlock, levelWidth, levelHeight);
    const levelMask = computeLevelWallMask(level);
    const levelRadius = Math.max(3, cellSize * 0.28);
    const drawLevelBacking = depth === 0;
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

    for (let y = 0; y < level.height; y += 1) {
      for (let x = 0; x < level.width; x += 1) {
        const floor = level.floors[y][x];
        if (floor) {
          this.drawFloor(floor, x * cellSize, y * cellSize, cellSize, state);
        }
      }
    }

    if (state.prefs.grid || state.drawStyle === "grid") {
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
    const phantoms = getRenderPhantomsForLevel(animation, level);
    const movingBlocks = [];
    const smallMovingBlocks = [];
    for (let y = 0; y < level.height; y += 1) {
      for (let x = 0; x < level.width; x += 1) {
        const block = level.blocks[y][x];
        if (!block) {
          continue;
        }
        const simpleSlide = shouldSimpleSlide(parentBlock, block, animation, parents, state.drawStyle, depth);
        const transform = resolveAnimatedDrawTransform(block, animation, parentBlock, simpleSlide);
        const move = animation?.turn?.moves?.find?.((entry) => entry.block?.id === block.id) ?? null;
        const drawStart = move ? resolveMoveDrawStart(move) : null;
        const item = { block, x: x * cellSize, y: y * cellSize, simpleSlide, parents };
        const moving = transform && (
          Math.abs(transform.offsetX) > 0.0001 ||
          Math.abs(transform.offsetY) > 0.0001 ||
          Math.abs(transform.scaleX - 1) > 0.0001 ||
          Math.abs(transform.scaleY - 1) > 0.0001
        );
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
      const rect = resolveBlockDrawRect(item.block, item.x, item.y, cellSize, animation, parentBlock, item.simpleSlide);
      this.drawBlockShadow?.(item.block, rect.drawX, rect.drawY, rect.width, rect.height, item.block.flipH, cellSize, cellSize);
    };
    const drawPhantomShadow = (phantom) => {
      const transform = resolveRenderPhantomTransform(phantom, animation);
      const width = cellSize * transform.scaleX;
      const height = cellSize * transform.scaleY;
      if (width <= 0 || height <= 0) {
        return;
      }
      const centerX = phantom.xpos * cellSize + cellSize / 2 + transform.offsetX * cellSize;
      const centerY = phantom.ypos * cellSize + cellSize / 2 + transform.offsetY * cellSize;
      this.drawBlockShadow?.(phantom.block, centerX - width / 2, centerY - height / 2, width, height, phantom.block.flipH, cellSize, cellSize);
    };
    for (const queue of [stillBlocks, movingBlocks, smallMovingBlocks]) {
      for (const item of queue) {
        drawItemShadow(item);
      }
    }
    for (const phantom of phantoms) {
      drawPhantomShadow(phantom);
    }
    for (const item of stillBlocks) {
      this.drawBlock(state, item.block, item.x, item.y, cellSize, animation, depth, path, parentBlock, item.simpleSlide, item.parents, false);
    }
    for (const phantom of phantoms) {
      this.drawRenderPhantom(state, phantom, cellSize, animation, depth, path, parentBlock, parents, false);
    }
    for (const queue of [movingBlocks, smallMovingBlocks]) {
      for (const item of queue) {
        this.drawBlock(state, item.block, item.x, item.y, cellSize, animation, depth, path, parentBlock, item.simpleSlide, item.parents, false);
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
    const reverse = Boolean(block.flipH || block.specialEffect === 3) !== flipH;
    const gradient = context.createLinearGradient(reverse ? x + width : x, y, reverse ? x : x + width, y);
    gradient.addColorStop(0, "rgba(255,255,255,0)");
    gradient.addColorStop(0.3, "rgba(255,255,255,0)");
    gradient.addColorStop(0.5, `rgba(255,255,255,${alpha})`);
    gradient.addColorStop(0.7, "rgba(255,255,255,0)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    context.save();
    context.fillStyle = gradient;
    context.fillRect(x, y, width, height);
    context.restore();
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
    const context = this.context;
    this.withHorizontalMirror(x, width, flipH, () => {
      const pixelStep = this.pixelRatio ? 1 / this.pixelRatio : 1;
      const viewport = computeLevelViewport(level, x, y, width, height, 0, 0.5, pixelStep);
      const previewX = viewport.originX;
      const previewY = viewport.originY;
      const cellSize = viewport.cellSize;
      const inset = Math.max(1, cellSize * 0.12);

      context.save();
      for (let yIndex = 0; yIndex < level.height; yIndex += 1) {
        for (let xIndex = 0; xIndex < level.width; xIndex += 1) {
          const floor = level.floors[yIndex][xIndex];
          if (!floor) {
            continue;
          }
          this.drawFloor(floor, previewX + xIndex * cellSize, previewY + yIndex * cellSize, cellSize, null);
        }
      }

      for (let yIndex = 0; yIndex < level.height; yIndex += 1) {
        for (let xIndex = 0; xIndex < level.width; xIndex += 1) {
          const block = level.blocks[yIndex][xIndex];
          if (!block) {
            continue;
          }
          const blockX = previewX + xIndex * cellSize;
          const blockY = previewY + yIndex * cellSize;
          if (block.kind === "wall") {
            this.drawWallBlock(block, blockX, blockY, cellSize, cellSize >= 9);
            continue;
          }
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

          this.drawFlipShine(block, blockX + inset, blockY + inset, Math.max(1, cellSize - inset * 2), Math.max(1, cellSize - inset * 2));

          if (shouldDrawInfinityEffect(block)) {
            const target = block.subLevel?.infZone ? infWindow : {
              x: blockX + inset,
              y: blockY + inset,
              width: Math.max(1, cellSize - inset * 2),
              height: Math.max(1, cellSize - inset * 2)
            };
            this.drawInfinityEffect(block, target.x, target.y, target.width, target.height);
          }

          if (block.isPlayer && cellSize >= 9) {
            this.drawFace(block, blockX + inset, blockY + inset, Math.max(1, cellSize - inset * 2), Math.max(1, cellSize - inset * 2), false);
          }
        }
      }

      context.restore();
    });
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
   */
  drawBlock(state, block, x, y, size, animation, depth, path = new Set(), parentBlock = null, simpleSlide = false, parents = [], drawShadow = true) {
    return this.drawBlockInternal(state, block, x, y, size, animation, depth, path, parentBlock, simpleSlide, parents, drawShadow);
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
   */
  drawBlockInternal(state, block, x, y, size, animation, depth, path, parentBlock = null, simpleSlide = false, parents = [], drawShadow = true) {
    const rect = resolveBlockDrawRect(block, x, y, size, animation, parentBlock, simpleSlide);
    this.drawBlockRect(state, block, rect.drawX, rect.drawY, rect.width, rect.height, size, animation, depth, path, parentBlock, simpleSlide, parents, block.flipH, drawShadow);
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
   */
  drawBlockRect(state, block, drawX, drawY, width, height, staticSize, animation, depth, path, parentBlock, simpleSlide, parents, flipH, drawShadow = true) {
    const context = this.context;
    if (block.kind === "wall") {
      if (drawShadow) {
        this.drawBlockShadow?.(block, drawX, drawY, width, height, flipH, staticSize, staticSize);
      }
      this.drawWallBlock(block, drawX, drawY, width, height, true, flipH);
      return;
    }

    const fillHsv = this.computeBlockHsv(block, width, height);
    const lineHsv = this.computeLineHsv(block, width, height, false);
    if (drawShadow) {
      this.drawBlockShadow?.(block, drawX, drawY, width, height, flipH, staticSize, staticSize);
    }
    const hasNested = shouldRenderNestedInterior(block);
    // C# block body is at alpha 0.5 (HSVToRGBGUI). For nested blocks, reduce
    // body opacity so empty cells in the sub-level show through at reduced brightness.
    this.drawColorBlockSurface(drawX, drawY, width, height, fillHsv, lineHsv, { bodyAlpha: hasNested ? 0.65 : 1 });
    this.drawBlockBorder(block, drawX, drawY, width, height, staticSize, lineHsv);

    let nestedWindow = null;
    if (hasNested) {
      nestedWindow = this.drawNestedShell(block, drawX, drawY, width, height, depth);
    }

    if (nestedWindow && shouldDrawNestedLevel(block, depth, path, Math.min(nestedWindow.width, nestedWindow.height))) {
      const childPath = new Set(path);
      childPath.add(block.subLevel.id);
      const pixelStep = this.pixelRatio ? 1 / this.pixelRatio : 1;
      const viewport = computeLevelViewport(block.subLevel, nestedWindow.x, nestedWindow.y, nestedWindow.width, nestedWindow.height, 0, 0.5, pixelStep);
      context.save();
      context.beginPath();
      context.rect(nestedWindow.x, nestedWindow.y, nestedWindow.width, nestedWindow.height);
      context.clip();
      this.withHorizontalMirror(nestedWindow.x, nestedWindow.width, flipH, () => {
        const childParents = parentBlock ? [parentBlock, ...parents] : [];
        this.drawLevelInternal(state, block.subLevel, viewport.originX, viewport.originY, viewport.cellSize, animation, depth + 1, childPath, block, childParents);
      });
      context.restore();
    } else if (nestedWindow) {
      this.drawCompactLevelPreview(block.subLevel, nestedWindow.x, nestedWindow.y, nestedWindow.width, nestedWindow.height, depth + 1, flipH);
    }

    if (nestedWindow) {
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
   */
  drawRenderPhantom(state, phantom, cellSize, animation, depth, path, parentBlock, parents, drawShadow = true) {
    const transform = resolveRenderPhantomTransform(phantom, animation);
    const width = cellSize * transform.scaleX;
    const height = cellSize * transform.scaleY;
    if (width <= 0 || height <= 0) {
      return;
    }
    const centerX = phantom.xpos * cellSize + cellSize / 2 + transform.offsetX * cellSize;
    const centerY = phantom.ypos * cellSize + cellSize / 2 + transform.offsetY * cellSize;
    const drawX = centerX - width / 2;
    const drawY = centerY - height / 2;
    this.drawBlockRect(state, phantom.block, drawX, drawY, width, height, cellSize, null, depth, path, parentBlock, false, parents, phantom.block.flipH, drawShadow);
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

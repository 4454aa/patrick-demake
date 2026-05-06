import {
  Attempt,
  DrawStyle,
  FloorType,
  applyPalette,
  computeBlockLists,
  createBlock,
  createFloor,
  createGameState,
  createInfZone,
  createMissingInfExitZones,
  createLevel,
  fillLevelWithWalls,
  getExitBlock,
  initBlock,
  initFloor,
  maybeFillDonut,
  registerBlock,
  registerFloor,
  registerLevel,
  resetEntityCounters,
  setExitBlock,
  updateButtonsPressed
} from "../core/model.js";
import { parseInvariantBoolean, parseInvariantFloat } from "./invariant.js";

/**
 * @param {string} order
 * @returns {string[]}
 */
export function parseAttemptOrder(order) {
  return order.split(",").map((part) => {
    if (part.includes("push")) {
      return Attempt.PUSH;
    }
    if (part.includes("enter")) {
      return Attempt.ENTER;
    }
    if (part.includes("eat")) {
      return Attempt.EAT;
    }
    if (part.includes("possess")) {
      return Attempt.POSSESS;
    }
    throw new Error(`Unsupported attempt token: ${part}`);
  });
}

/**
 * @param {number} x
 * @param {number} y
 * @param {number} width
 * @param {number} height
 * @param {boolean} flip
 * @param {number} rotation
 * @returns {[number, number]}
 */
function transformPoint(x, y, width, height, flip, rotation) {
  let nextX = x;
  let nextY = height - 1 - y;
  if (flip) {
    nextX = width - 1 - nextX;
  }
  const originalX = nextX;
  const originalY = nextY;
  if (rotation === 1) {
    nextX = originalY;
    nextY = width - 1 - originalX;
  } else if (rotation === 2) {
    nextX = width - 1 - originalX;
    nextY = height - 1 - originalY;
  } else if (rotation === 3) {
    nextX = width - 1 - originalY;
    nextY = originalX;
  }
  return [nextX, nextY];
}

/**
 * @param {string} text
 * @param {Partial<any>} [context]
 * @returns {any}
 */
export function parseLevelText(text, context = {}) {
  resetEntityCounters();
  const state = createGameState({
    currentLevelName: context.currentLevelName ?? "custom_level",
    sourceText: text,
    database: context.database ?? null,
    moveDelay: context.moveDelay ?? 70,
    allowSkippingAnimation: context.allowSkippingAnimation ?? false,
    instantZoom: context.instantZoom ?? false,
    enterSpeedIndex: context.enterSpeedIndex ?? 0,
    grid: context.grid ?? false,
    language: context.language ?? "Default",
    initialContext: { ...context }
  });

  const allWon = context.allWon ?? false;
  const nexusUnlocked = context.nexusUnlocked ?? false;
  const unlockPuzzles = context.unlockPuzzles ?? false;
  const isHub = state.currentLevelName === "hub";

  /** @type {Array<any>} */
  const stack = [];
  /** @type {Array<any>} */
  const refLines = [];
  /** @type {Map<number, any>} */
  const levelIds = new Map();

  let header = true;
  let customLevelPalette = -1;
  let randomFlip = false;
  let randomRotation = 0;

  const rows = text
    .replace(/\r/g, "")
    .split("\n")
    .filter((line) => line.length > 0);

  for (const rawLine of rows) {
    const args = rawLine.split(" ");
    if (header) {
      if (args[0] === "#") {
        header = false;
        continue;
      }
      if (args[0] === "version" && args[1] !== "4") {
        throw new Error(`Unsupported level version ${args[1]}`);
      }
      if (args[0] === "attempt_order") {
        state.attemptOrder = parseAttemptOrder(args[1]);
        state.showAttemptOrder = true;
      }
      if (args[0] === "shed") {
        state.shedEnabled = parseInvariantBoolean(args[1]);
      }
      if (args[0] === "inner_push") {
        state.innerPushEnabled = parseInvariantBoolean(args[1]);
      }
      if (args[0] === "draw_style") {
        if (args[1] === "tui") {
          state.drawStyle = DrawStyle.TUI;
        } else if (args[1] === "grid") {
          state.drawStyle = DrawStyle.GRID;
        } else if (args[1] === "oldstyle") {
          state.drawStyle = DrawStyle.OLDSTYLE;
        }
      }
      if (args[0] === "custom_level_music") {
        state.customLevelMusic = Number.parseInt(args[1], 10);
      }
      if (args[0] === "custom_level_palette") {
        customLevelPalette = Number.parseInt(args[1], 10);
        state.customLevelPalette = customLevelPalette;
      }
      continue;
    }

    let depth = 0;
    while (depth < args[0].length && args[0][depth] === "\t") {
      depth += 1;
    }
    while (depth < stack.length) {
      stack.pop();
    }

    args[0] = args[0].replace(/^\t+/, "");
    const type = args[0];

    if (type === "Block") {
      let index = 1;
      let x = Number.parseInt(args[index++], 10);
      let y = Number.parseInt(args[index++], 10);
      const key = Number.parseInt(args[index++], 10);
      const width = Number.parseInt(args[index++], 10);
      const height = Number.parseInt(args[index++], 10);
      const hue = parseInvariantFloat(args[index++]);
      const sat = parseInvariantFloat(args[index++]);
      const val = parseInvariantFloat(args[index++]);
      const camZoomFactor = parseInvariantFloat(args[index++]);
      const fillWalls = parseInvariantBoolean(args[index++]);
      const isPlayer = parseInvariantBoolean(args[index++]);
      const possessable = parseInvariantBoolean(args[index++]);
      const playerOrder = Number.parseInt(args[index++], 10);
      const flipH = parseInvariantBoolean(args[index++]);
      const generatedInf = parseInvariantBoolean(args[index++]);
      const specialEffect = Number.parseInt(args[index++], 10);

      const block = createBlock({
        hue,
        sat,
        val,
        startHue: hue,
        startSat: sat,
        startVal: val,
        isPlayer,
        drawIsPlayer: isPlayer,
        isPlayerStart: isPlayer,
        playerOrder,
        playerOrderStart: playerOrder,
        flipH,
        flipHStart: flipH,
        tempFlipH: flipH,
        possessable,
        generatedInf,
        specialEffect
      });
      const level = createLevel({ width, height, camZoomFactor });
      registerBlock(state, block);
      registerLevel(state, level);

      if (stack.length === 0) {
        if (specialEffect === 9) {
          const inf = createInfZone(state);
          initBlock(block, inf.subLevel, level, Math.floor(inf.subLevel.width / 2), Math.floor(inf.subLevel.height / 2));
        } else {
          initBlock(block, null, level, x, y);
        }
      } else if (specialEffect === 6) {
        initBlock(block, null, level, 0, 0);
        level.hubAreaName = "Area_Intro";
      } else if (generatedInf) {
        if (specialEffect === 11) {
          initBlock(block, null, level, 0, 0);
        } else {
          const inf = createInfZone(state);
          initBlock(block, inf.subLevel, level, Math.floor(inf.subLevel.width / 2), Math.floor(inf.subLevel.height / 2));
        }
      } else {
        const parent = stack[stack.length - 1];
        [x, y] = transformPoint(x, y, parent.subLevel.width, parent.subLevel.height, randomFlip, randomRotation);
        initBlock(block, parent.subLevel, level, x, y);
      }

      if (fillWalls) {
        fillLevelWithWalls(state, level);
      }
      if (isHub && depth === 1) {
        level.tempFTXpos = x;
        level.tempFTYpos = y;
      }

      levelIds.set(key, level);
      stack.push(block);
      continue;
    }

    if (type === "Wall") {
      let index = 1;
      let x = Number.parseInt(args[index++], 10);
      let y = Number.parseInt(args[index++], 10);
      const isPlayer = parseInvariantBoolean(args[index++]);
      const possessable = parseInvariantBoolean(args[index++]);
      const playerOrder = Number.parseInt(args[index++], 10);
      let unlockerScene = null;
      if (isHub && args[index]) {
        unlockerScene = args[index] === "_" ? null : args[index];
      }
      const parent = stack[stack.length - 1];
      [x, y] = transformPoint(x, y, parent.subLevel.width, parent.subLevel.height, randomFlip, randomRotation);
      const block = createBlock({
        kind: "wall",
        isPlayer,
        drawIsPlayer: isPlayer,
        isPlayerStart: isPlayer,
        playerOrder,
        playerOrderStart: playerOrder,
        possessable,
        unlockerScene
      });
      registerBlock(state, block);
      initBlock(block, parent.subLevel, null, x, y);
      continue;
    }

    if (type === "Floor") {
      let index = 1;
      let x = Number.parseInt(args[index++], 10);
      let y = Number.parseInt(args[index++], 10);
      const floorKind = args[index++];
      const parent = stack[stack.length - 1];
      [x, y] = transformPoint(x, y, parent.subLevel.width, parent.subLevel.height, randomFlip, randomRotation);
      const level = parent.subLevel;

      if (floorKind === "Button") {
        const floor = createFloor({ type: FloorType.BUTTON });
        registerFloor(state, floor);
        initFloor(floor, level, x, y);
        continue;
      }
      if (floorKind === "PlayerButton") {
        const floor = createFloor({ type: FloorType.PLAYER_BUTTON });
        registerFloor(state, floor);
        initFloor(floor, level, x, y);
        continue;
      }
      if (floorKind === "Portal") {
        const sceneName = args[index++];
        const floor = createFloor({
          type: FloorType.LEVEL_PORTAL,
          sceneName,
          hard: state.database?.puzzleData?.get(sceneName)?.hard ?? 0,
          won: false
        });
        registerFloor(state, floor);
        initFloor(floor, level, x, y);
        continue;
      }
      if (floorKind === "Info") {
        if (state.currentLevelName === "custom_level") {
          const floor = createFloor({
            type: FloorType.INFO,
            info: args[index++].replaceAll("_", " ").replaceAll("\\n", "\n").replaceAll("\\\\", "\\")
          });
          registerFloor(state, floor);
          initFloor(floor, level, x, y);
          continue;
        }
        const infoKey = args[index++];
        if ((infoKey === "Sign_100Percent" && !allWon) || (infoKey === "Sign_Congratulations" && !nexusUnlocked)) {
          continue;
        }
        const floor = createFloor({
          type: FloorType.INFO,
          info: infoKey,
          localizeInfo: true,
          hundredPercent: infoKey === "Sign_100Percent",
          star: infoKey === "Sign_100Percent" || infoKey === "Sign_Congratulations"
        });
        registerFloor(state, floor);
        initFloor(floor, level, x, y);
        continue;
      }
      if (floorKind === "Break") {
        const floor = createFloor({ type: FloorType.BREAK });
        registerFloor(state, floor);
        initFloor(floor, level, x, y);
        continue;
      }
      if (floorKind === "FastTravel") {
        const floor = createFloor({ type: FloorType.FAST_TRAVEL });
        registerFloor(state, floor);
        initFloor(floor, level, x, y);
        state.fastTravelFloors.push(floor);
        continue;
      }
      if (floorKind === "Gallery") {
        const floor = createFloor({ type: FloorType.GALLERY });
        registerFloor(state, floor);
        initFloor(floor, level, x, y);
        continue;
      }
      if (floorKind === "DemoEnd") {
        const floor = createFloor({ type: FloorType.DEMO_END });
        registerFloor(state, floor);
        initFloor(floor, level, x, y);
        continue;
      }
      if (floorKind === "Smile") {
        if (!allWon) {
          continue;
        }
        const floor = createFloor({ type: FloorType.SMILE });
        registerFloor(state, floor);
        initFloor(floor, level, x, y);
        continue;
      }
      if (floorKind === "Show") {
        if (!allWon) {
          continue;
        }
        const floor = createFloor({ type: FloorType.SHOW });
        registerFloor(state, floor);
        initFloor(floor, level, x, y);
      }
      continue;
    }

    if (type === "Ref") {
      refLines.push({ args: [...args], parentBlock: stack[stack.length - 1], depth });
    }
  }

  for (const line of refLines) {
    processRefLine(state, line, levelIds, {
      isHub,
      nexusUnlocked,
      unlockPuzzles,
      randomFlip,
      randomRotation
    });
  }

  computeBlockLists(state);
  for (const level of state.levels) {
    maybeFillDonut(state, level);
  }
  computeBlockLists(state);
  createMissingInfExitZones(state);
  computeBlockLists(state);
  applyPalette(state);
  updateButtonsPressed(state);

  return state;
}

/**
 * @param {any} state
 * @param {any} line
 * @param {Map<number, any>} levelIds
 * @param {{ isHub: boolean, nexusUnlocked: boolean, unlockPuzzles: boolean, randomFlip: boolean, randomRotation: number }} flags
 */
function processRefLine(state, line, levelIds, flags) {
  const args = line.args;
  const parentBlock = line.parentBlock;
  let index = 1;
  let x = Number.parseInt(args[index++], 10);
  let y = Number.parseInt(args[index++], 10);
  const key = Number.parseInt(args[index++], 10);
  let setExit = parseInvariantBoolean(args[index++]);
  const hasInfExit = parseInvariantBoolean(args[index++]);
  const infExitNum = Number.parseInt(args[index++], 10);
  const hasInfEnter = parseInvariantBoolean(args[index++]);
  const infEnterNum = Number.parseInt(args[index++], 10);
  const infEnterLevelKey = Number.parseInt(args[index++], 10);
  const isPlayer = parseInvariantBoolean(args[index++]);
  const possessable = parseInvariantBoolean(args[index++]);
  const playerOrder = Number.parseInt(args[index++], 10);
  const flipH = parseInvariantBoolean(args[index++]);
  let generatedInf = parseInvariantBoolean(args[index++]);
  const specialEffect = Number.parseInt(args[index++], 10);
  let hubAreaName = null;
  if (flags.isHub && args[index]) {
    hubAreaName = args[index] === "_" ? null : args[index];
  }

  const level = levelIds.get(key);
  if (!level) {
    throw new Error(`Unknown Ref level id ${key}`);
  }

  if (specialEffect === 10 && !flags.nexusUnlocked && !flags.unlockPuzzles) {
    generatedInf = true;
  }

  const block = createBlock({
    hue: 0,
    sat: 0,
    val: 0,
    startHue: 0,
    startSat: 0,
    startVal: 0,
    isPlayer,
    drawIsPlayer: isPlayer,
    isPlayerStart: isPlayer,
    playerOrder,
    playerOrderStart: playerOrder,
    flipH,
    flipHStart: flipH,
    tempFlipH: flipH,
    possessable,
    generatedInf,
    specialEffect
  });
  registerBlock(state, block);

  if (generatedInf) {
    const inf = createInfZone(state);
    initBlock(block, inf.subLevel, level, Math.floor(inf.subLevel.width / 2), Math.floor(inf.subLevel.height / 2));
  } else {
    [x, y] = transformPoint(x, y, parentBlock.subLevel.width, parentBlock.subLevel.height, flags.randomFlip, flags.randomRotation);
    initBlock(block, parentBlock.subLevel, level, x, y);
  }

  const exitBlock = getExitBlock(level);
  if (exitBlock) {
    block.hue = exitBlock.hue;
    block.sat = exitBlock.sat;
    block.val = exitBlock.val;
    block.startHue = exitBlock.hue;
    block.startSat = exitBlock.sat;
    block.startVal = exitBlock.val;
  }

  if (specialEffect === 6) {
    setExit = flags.nexusUnlocked;
  }
  if (setExit) {
    setExitBlock(level, block);
  }

  if (hasInfExit) {
    while (level.infExitBlocks.length < infExitNum + 1) {
      level.infExitBlocks.push(null);
    }
    level.infExitBlocks[infExitNum] = block;
    level.infExitBlockSet = true;
    block.isSomeInfExitBlock = true;
  }

  if (hasInfEnter) {
    const target = levelIds.get(infEnterLevelKey);
    if (target) {
      level.infEffect = true;
      while (target.infEnterBlocks.length < infEnterNum + 1) {
        target.infEnterBlocks.push(null);
      }
      target.infEnterBlocks[infEnterNum] = block;
      target.infEnterBlockSet = true;
      block.isSomeInfEnterBlock = true;
      block.someInfEnterNum = infEnterNum;
    }
  }

  if (hubAreaName && block.subLevel) {
    block.subLevel.hubAreaName = hubAreaName;
    block.subLevel.indexDisplayName = hubAreaName;
  }
}

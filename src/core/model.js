import { clamp, hsvToCss } from "../parser/invariant.js";

export const Attempt = {
  PUSH: "push",
  ENTER: "enter",
  EAT: "eat",
  POSSESS: "possess"
};

export const FloorType = {
  BUTTON: "Button",
  PLAYER_BUTTON: "PlayerButton",
  LEVEL_PORTAL: "Portal",
  INFO: "Info",
  BREAK: "Break",
  FAST_TRAVEL: "FastTravel",
  GALLERY: "Gallery",
  DEMO_END: "DemoEnd",
  SMILE: "Smile",
  SHOW: "Show"
};

export const DrawStyle = {
  NORMAL: "normal",
  TUI: "tui",
  GRID: "grid",
  OLDSTYLE: "oldstyle"
};

let nextLevelId = 1;
let nextBlockId = 1;
let nextFloorId = 1;

export function resetEntityCounters() {
  nextLevelId = 1;
  nextBlockId = 1;
  nextFloorId = 1;
}

/**
 * @returns {string[]}
 */
export function defaultAttemptOrder() {
  return [Attempt.PUSH, Attempt.ENTER, Attempt.EAT, Attempt.POSSESS];
}

/**
 * @param {number} width
 * @param {number} height
 * @returns {Array<Array<null>>}
 */
function createGrid(width, height) {
  return Array.from({ length: height }, () => Array.from({ length: width }, () => null));
}

/**
 * @param {Partial<any>} [overrides]
 * @returns {any}
 */
export function createLevel(overrides = {}) {
  const width = overrides.width ?? 1;
  const height = overrides.height ?? 1;
  return {
    id: nextLevelId++,
    width,
    height,
    blocks: createGrid(width, height),
    floors: createGrid(width, height),
    blocksWithThisAsTheirSubLevel: [],
    exitBlock: null,
    infExitBlocks: [],
    infEnterBlocks: [],
    blockList: [],
    floorList: [],
    infEffect: false,
    infZone: false,
    camZoomFactor: 1,
    infExitBlockSet: false,
    infEnterBlockSet: false,
    filledWithWalls: false,
    hubAreaName: "",
    indexDisplayName: "",
    hubShowInTui: false,
    tempFTXpos: 0,
    tempFTYpos: 0,
    ...overrides
  };
}

/**
 * @param {Partial<any>} [overrides]
 * @returns {any}
 */
export function createBlock(overrides = {}) {
  return {
    id: nextBlockId++,
    kind: "block",
    outerLevel: null,
    subLevel: null,
    xpos: 0,
    ypos: 0,
    hue: 0,
    sat: 0,
    val: 0.8,
    startHue: 0,
    startSat: 0,
    startVal: 0.8,
    borderColor: "#203038",
    isPlayer: false,
    drawIsPlayer: false,
    isPlayerStart: false,
    playerOrder: 0,
    playerOrderStart: 0,
    flipH: false,
    tempFlipH: false,
    flipHStart: false,
    fadeFlipH: false,
    possessable: false,
    tempInnerPush: false,
    justEnteredArray: null,
    justInfEntered: false,
    movedSinceRestart: false,
    isSomeInfEnterBlock: false,
    someInfEnterNum: -1,
    isSomeInfExitBlock: false,
    generatedInf: false,
    specialEffect: 0,
    unlockerScene: null,
    outerLevelStart: null,
    xposStart: 0,
    yposStart: 0,
    ...overrides
  };
}

/**
 * @param {Partial<any>} [overrides]
 * @returns {any}
 */
export function createFloor(overrides = {}) {
  return {
    id: nextFloorId++,
    outerLevel: null,
    xpos: 0,
    ypos: 0,
    type: FloorType.BUTTON,
    sceneName: null,
    won: false,
    unlocked: false,
    hard: 0,
    info: "",
    localizeInfo: false,
    star: false,
    hundredPercent: false,
    portalSize: 1,
    jumpX: 3,
    jumpY: 3,
    jumpW: 7,
    jumpH: 7,
    ...overrides
  };
}

/**
 * @param {Partial<any>} [overrides]
 * @returns {any}
 */
export function createGameState(overrides = {}) {
  return {
    currentLevelName: overrides.currentLevelName ?? "custom_level",
    sourceText: overrides.sourceText ?? "",
    levels: [],
    blocks: [],
    floors: [],
    playerBlocks: [],
    fastTravelFloors: [],
    focusBlock: null,
    attemptOrder: overrides.attemptOrder ? [...overrides.attemptOrder] : defaultAttemptOrder(),
    showAttemptOrder: false,
    shedEnabled: false,
    innerPushEnabled: false,
    drawStyle: DrawStyle.NORMAL,
    customLevelMusic: -1,
    customLevelPalette: -1,
    moveCount: 0,
    buttonsSatisfied: false,
    finishesSatisfied: false,
    winning: false,
    wentToInfZone: false,
    recordsVersion: 1,
    prefs: {
      moveDelay: overrides.moveDelay ?? 70,
      allowSkippingAnimation: overrides.allowSkippingAnimation ?? false,
      instantZoom: overrides.instantZoom ?? false,
      enterSpeedIndex: overrides.enterSpeedIndex ?? 0,
      grid: overrides.grid ?? false,
      language: overrides.language ?? "Default"
    },
    undoStack: [],
    redoStack: [],
    lastTurn: null,
    database: overrides.database ?? null,
    initialContext: overrides.initialContext ?? null
  };
}

/**
 * @param {any} state
 * @param {any} level
 * @param {number} x
 * @param {number} y
 * @returns {boolean}
 */
export function inBounds(state, level, x, y) {
  void state;
  return x >= 0 && x < level.width && y >= 0 && y < level.height;
}

/**
 * @param {any} state
 */
export function computeBlockLists(state) {
  const playerBlocks = [];
  for (const level of state.levels) {
    level.blockList = [];
    level.floorList = [];
    level.blocksWithThisAsTheirSubLevel = [];
  }

  // Owner links can point to levels that are visited later, so rebuild them in
  // a separate pass instead of clearing each level while scanning it.
  for (const level of state.levels) {
    for (const row of level.blocks) {
      for (const block of row) {
        if (block) {
          level.blockList.push(block);
          if (block.isPlayer) {
            playerBlocks.push(block);
          }
          if (block.subLevel) {
            block.subLevel.blocksWithThisAsTheirSubLevel.push(block);
          }
        }
      }
    }
    for (const row of level.floors) {
      for (const floor of row) {
        if (floor) {
          level.floorList.push(floor);
        }
      }
    }
  }

  for (const level of state.levels) {
    if (level.exitBlock && level.blocksWithThisAsTheirSubLevel.includes(level.exitBlock)) {
      level.blocksWithThisAsTheirSubLevel = [
        level.exitBlock,
        ...level.blocksWithThisAsTheirSubLevel.filter((item) => item !== level.exitBlock)
      ];
    }
  }
  state.playerBlocks = playerBlocks.sort((left, right) => left.playerOrder - right.playerOrder || left.id - right.id);
  state.focusBlock = state.playerBlocks[0] ?? null;
}

/**
 * @param {any} level
 * @returns {any | null}
 */
export function getExitBlock(level) {
  return level.exitBlock ?? level.blocksWithThisAsTheirSubLevel[0] ?? null;
}

/**
 * @param {any} level
 * @param {any} block
 */
export function setExitBlock(level, block) {
  level.exitBlock = block;
  level.blocksWithThisAsTheirSubLevel = [
    block,
    ...level.blocksWithThisAsTheirSubLevel.filter((item) => item !== block)
  ];
}

/**
 * @param {any} block
 * @param {any | null} outerLevel
 * @param {any | null} subLevel
 * @param {number} x
 * @param {number} y
 */
export function initBlock(block, outerLevel, subLevel, x, y) {
  block.outerLevel = outerLevel;
  block.subLevel = subLevel;
  block.xpos = x;
  block.ypos = y;
  if (subLevel && !subLevel.exitBlock) {
    subLevel.exitBlock = block;
  }
  if (block.outerLevelStart === null && block.xposStart === 0 && block.yposStart === 0 && !block.movedSinceRestart) {
    block.outerLevelStart = outerLevel;
    block.xposStart = x;
    block.yposStart = y;
  }
  block.tempFlipH = block.flipH;
  if (outerLevel) {
    outerLevel.blocks[y][x] = block;
  }
}

/**
 * @param {any} floor
 * @param {any} outerLevel
 * @param {number} x
 * @param {number} y
 */
export function initFloor(floor, outerLevel, x, y) {
  floor.outerLevel = outerLevel;
  floor.xpos = x;
  floor.ypos = y;
  outerLevel.floors[y][x] = floor;
}

/**
 * @param {any} state
 * @param {any} block
 */
export function registerBlock(state, block) {
  state.blocks.push(block);
}

/**
 * @param {any} state
 * @param {any} floor
 */
export function registerFloor(state, floor) {
  state.floors.push(floor);
}

/**
 * @param {any} state
 * @param {any} level
 */
export function registerLevel(state, level) {
  state.levels.push(level);
}

/**
 * @param {any} state
 * @param {any} level
 */
export function fillLevelWithWalls(state, level) {
  level.width = 1;
  level.height = 1;
  level.blocks = createGrid(1, 1);
  level.floors = createGrid(1, 1);
  const block = createBlock({ kind: "wall" });
  registerBlock(state, block);
  initBlock(block, level, null, 0, 0);
  level.filledWithWalls = true;
}

/**
 * @param {any} state
 * @returns {any}
 */
export function createInfZone(state) {
  const level = createLevel({ width: 7, height: 7, infEffect: true, infZone: true });
  const block = createBlock({ hue: 0, sat: 0, val: 0.3, startHue: 0, startSat: 0, startVal: 0.3 });
  registerLevel(state, level);
  registerBlock(state, block);
  initBlock(block, null, level, 0, 0);
  return block;
}

/**
 * @param {any} state
 * @param {any} level
 * @param {number} infExitNum
 * @returns {any}
 */
export function createInfExitZone(state, level, infExitNum) {
  const zoneBlock = createInfZone(state);
  const exitBlock = getExitBlock(level);
  const block = createBlock({
    hue: exitBlock?.hue ?? 0,
    sat: exitBlock?.sat ?? 0,
    val: exitBlock?.val ?? 0.3,
    startHue: exitBlock?.hue ?? 0,
    startSat: exitBlock?.sat ?? 0,
    startVal: exitBlock?.val ?? 0.3,
    isSomeInfExitBlock: true,
    generatedInf: true
  });
  registerBlock(state, block);
  initBlock(block, zoneBlock.subLevel, level, Math.floor(zoneBlock.subLevel.width / 2), Math.floor(zoneBlock.subLevel.height / 2));
  while (level.infExitBlocks.length < infExitNum + 1) {
    level.infExitBlocks.push(null);
  }
  level.infExitBlocks[infExitNum] = block;
  return block;
}

/**
 * @param {any} state
 * @param {any} level
 * @param {number} infEnterNum
 * @returns {any}
 */
export function createInfEnterZone(state, level, infEnterNum) {
  const zoneBlock = createInfZone(state);
  const outerLevel = createLevel({ width: 5, height: 5 });
  const exitBlock = getExitBlock(level);
  const block = createBlock({
    hue: exitBlock?.hue ?? 0,
    sat: exitBlock?.sat ?? 0,
    val: exitBlock?.val ?? 0.3,
    startHue: exitBlock?.hue ?? 0,
    startSat: exitBlock?.sat ?? 0,
    startVal: exitBlock?.val ?? 0.3,
    isSomeInfEnterBlock: true,
    someInfEnterNum: infEnterNum,
    generatedInf: true
  });
  registerLevel(state, outerLevel);
  registerBlock(state, block);
  initBlock(block, zoneBlock.subLevel, outerLevel, Math.floor(zoneBlock.subLevel.width / 2), Math.floor(zoneBlock.subLevel.height / 2));
  while (level.infEnterBlocks.length < infEnterNum + 1) {
    level.infEnterBlocks.push(null);
  }
  level.infEnterBlocks[infEnterNum] = block;
  return block;
}

/**
 * @param {any} state
 */
export function createMissingInfExitZones(state) {
  for (const level of [...state.levels]) {
    if (!level.infExitBlockSet && !level.filledWithWalls && !level.infZone) {
      createInfExitZone(state, level, 0);
    }
  }
}

/**
 * @param {any} state
 * @param {any} level
 */
export function maybeFillDonut(state, level) {
  if (level.filledWithWalls || level.infZone || level.floorList.length > 0) {
    return;
  }

  for (const block of level.blockList) {
    const onBorder = block.xpos === 0 || block.ypos === 0 || block.xpos === level.width - 1 || block.ypos === level.height - 1;
    if (block.subLevel || !onBorder || block.possessable || block.isPlayer) {
      return;
    }
  }

  for (let y = 0; y < level.height; y += 1) {
    for (let x = 0; x < level.width; x += 1) {
      const onBorder = x === 0 || y === 0 || x === level.width - 1 || y === level.height - 1;
      if (onBorder && !level.blocks[y][x]) {
        return;
      }
    }
  }

  fillLevelWithWalls(state, level);
}

/**
 * @param {any} state
 */
export function applyPalette(state) {
  const paletteIndex = resolvePaletteIndex(state);
  const palette = state.database?.palettes?.[paletteIndex];
  if (!palette || state.currentLevelName === "hub") {
    computeBorderColors(state);
    return;
  }

  for (const block of state.blocks) {
    if (!block.subLevel || block.subLevel.infZone) {
      continue;
    }
    let color = null;
    if (block.startSat === 0) {
      color = palette.root;
    } else if (block.startHue === 0.6) {
      color = palette.blue;
    } else if (block.startHue === 0.4) {
      color = palette.green;
    } else if (block.startHue === 0.1) {
      color = palette.orange;
    } else if (block.startHue === 0.9) {
      color = palette.player;
    } else if (block.startHue === 0.55) {
      color = palette.teal;
    }
    if (color) {
      block.hue = color.hue;
      block.sat = color.sat;
      block.val = color.val;
    }
  }

  computeBorderColors(state);
}

/**
 * @param {any} state
 * @returns {number}
 */
export function resolvePaletteIndex(state) {
  if (state.customLevelPalette >= 0) {
    return state.customLevelPalette;
  }
  return state.database?.puzzleData?.get(state.currentLevelName)?.palette ?? 0;
}

/**
 * @param {any} state
 */
export function computeBorderColors(state) {
  for (const block of state.blocks) {
    block.borderColor = hsvToCss(block.hue, clamp(block.sat * 1.2, 0, 1), clamp(block.val * 0.18, 0, 1));
  }
}

/**
 * @param {any} state
 */
export function updateButtonsPressed(state) {
  let buttonsSatisfied = true;
  let finishesSatisfied = true;
  let sawFinish = false;

  for (const floor of state.floors) {
    const block = floor.outerLevel.blocks[floor.ypos][floor.xpos];
    if (floor.type === FloorType.BUTTON) {
      if (!block || block.isPlayer || !block.subLevel) {
        buttonsSatisfied = false;
      }
      continue;
    }
    if (floor.type === FloorType.PLAYER_BUTTON) {
      sawFinish = true;
      if (!block || !block.isPlayer || !block.subLevel) {
        finishesSatisfied = false;
      }
    }
  }

  if (!sawFinish) {
    finishesSatisfied = false;
  }

  state.buttonsSatisfied = buttonsSatisfied;
  state.finishesSatisfied = finishesSatisfied;
  state.winning = buttonsSatisfied && finishesSatisfied && state.currentLevelName !== "hub";
}

/**
 * @param {any} state
 * @param {any} block
 */
export function findPathToRoot(state, block) {
  void state;
  const path = [];
  let current = block?.outerLevel ?? null;
  while (current) {
    const exitBlock = getExitBlock(current);
    if (!exitBlock || !exitBlock.outerLevel) {
      path.unshift(current);
      break;
    }
    path.unshift(current);
    current = exitBlock.outerLevel;
  }
  return path;
}

/**
 * @param {any} state
 * @returns {any}
 */
export function snapshotState(state) {
  return {
    currentLevelName: state.currentLevelName,
    moveCount: state.moveCount,
    winning: state.winning,
    buttonsSatisfied: state.buttonsSatisfied,
    finishesSatisfied: state.finishesSatisfied,
    blocks: state.blocks
      .map((block) => ({
        id: block.id,
        outerLevelId: block.outerLevel?.id ?? null,
        subLevelId: block.subLevel?.id ?? null,
        x: block.xpos,
        y: block.ypos,
        isPlayer: block.isPlayer,
        playerOrder: block.playerOrder,
        flipH: block.flipH,
        possessable: block.possessable,
        kind: block.kind
      }))
      .sort((left, right) => left.id - right.id),
    floors: state.floors
      .map((floor) => ({
        id: floor.id,
        outerLevelId: floor.outerLevel.id,
        x: floor.xpos,
        y: floor.ypos,
        type: floor.type,
        sceneName: floor.sceneName
      }))
      .sort((left, right) => left.id - right.id)
  };
}

import {
  Attempt,
  createInfEnterZone,
  createInfExitZone,
  getExitBlock,
  inBounds,
  snapshotState,
  updateButtonsPressed,
  computeBlockLists
} from "./model.js";
import { inverseLerp, lerp, signInt } from "../parser/invariant.js";
import { parseLevelText } from "../parser/level.js";

/**
 * @param {any} state
 * @param {string} command
 * @returns {any}
 */
export function runInputCommand(state, command, directionOverride = null) {
  if (command === "Z") {
    return undoTurn(state);
  }
  if (command === "Y") {
    return redoTurn(state);
  }
  if (command === "Restart") {
    return restartLevel(state);
  }
  const direction = directionOverride ?? commandToDirection(command);
  if (!direction) {
    return null;
  }
  // C# iterates all isPlayer blocks via DoNextMultiPlayerImpulse (one per frame).
  // JS processes them sequentially within a single command, merging their turns.
  const players = [...(state.playerBlocks ?? [])];
  if (players.length === 0) {
    return null;
  }
  // Each player gets their own Impulse → own Turn → own undoStack entry.
  // This matches C# DoNextMultiPlayerImpulse behavior.
  let lastTurn = null;
  let playerCount = 0;
  const groupId = state.moveCount; // common group marker for this input
  let animMoves = []; // merged moves for animation
  let animChanges = [];
  for (const player of players) {
    const transition = tryImpulse(state, player.id, direction);
    if (!transition) continue;
    if (transition.moves.length === 0 && transition.playerChanges.length === 0) continue;
    playerCount++;
    lastTurn = applyTransition(state, transition);
    lastTurn.mpGroup = groupId;
    lastTurn.mpIndex = playerCount - 1;
    for (const m of lastTurn.moves ?? []) animMoves.push(m);
    for (const c of lastTurn.playerChanges ?? []) animChanges.push(c);
  }
  if (lastTurn && playerCount > 1) {
    lastTurn.mpCount = playerCount;
    // Replace moves/playerChanges with merged versions for smooth animation
    lastTurn.moves = animMoves;
    lastTurn.playerChanges = dedupePlayerChanges(animChanges);
  }
  return lastTurn;
}

/**
 * @param {string} command
 * @returns {{ dx: number, dy: number } | null}
 */
export function commandToDirection(command) {
  if (command === "U") {
    return { dx: 0, dy: -1 };
  }
  if (command === "D") {
    return { dx: 0, dy: 1 };
  }
  if (command === "L") {
    return { dx: -1, dy: 0 };
  }
  if (command === "R") {
    return { dx: 1, dy: 0 };
  }
  return null;
}

/**
 * @param {any} state
 * @param {number} playerId
 * @param {{ dx: number, dy: number }} dir
 * @returns {any | null}
 */
export function tryImpulse(state, playerId, dir) {
  const player = state.blocks.find((block) => block.id === playerId);
  if (!player) {
    return null;
  }
  const transition = {
    kind: "turn",
    moveCountBefore: state.moveCount,
    moveCountAfter: state.moveCount + 1,
    moves: [],
    renderPhantoms: [],
    playerChanges: [],
    command: dir.dx === 1 ? "R" : dir.dx === -1 ? "L" : dir.dy === 1 ? "D" : "U",
    stateBefore: snapshotState(state),
    // C# UndoManager.Turn fields. These are deliberately stored on the
    // transition instead of inferred later by the renderer.
    animLengthSeconds: 0.1,
    camX: 0,
    camY: 0,
    camXS: 1,
    camYS: 1,
    cameraMovedThisTurn: false,
    cameraProjection: null,
    cameraFlipChanged: false,
    fromCameraFlipH: false,
    toCameraFlipH: false
  };

  const context = {
    state,
    searchMoves: [],
    transition,
    resolvedMoves: new Map(),
    cancelAllMovement: false,
    infExitUnwinding: false,
    infExitUnwindTo: -1,
    infEnterUnwinding: false,
    infEnterUnwindTo: -1,
    interloper: null,
    nudge: false,
    possess: false,
    wentToInfZoneChanged: false
  };

  for (const block of state.blocks) {
    block.tempFlipH = block.flipH;
    block.tempInnerPush = false;
    block.justEnteredArray = null;
    block.justInfEntered = false;
  }

  const succeeded = attemptToSlide(context, player, dir.dx, dir.dy);
  if (!succeeded) {
    return null;
  }

  transition.moves = [...context.resolvedMoves.values()];
  transition.animLengthSeconds = computeAnimLengthSeconds(transition.moves, state);
  transition.renderPhantoms = buildRenderPhantoms(transition.moves);
  transition.playerChanges = dedupePlayerChanges(transition.playerChanges);
  transition.wentToInfZoneChanged = context.wentToInfZoneChanged;
  if (transition.moves.length === 0 && transition.playerChanges.length === 0) {
    return null;
  }
  return transition;
}

/**
 * @param {any} state
 * @param {any} transition
 * @returns {any}
 */
export function applyTransition(state, transition) {
  applyTurn(state, transition, "forward");
  state.moveCount = transition.moveCountAfter;
  state.undoStack.push(transition);
  state.redoStack = [];
  state.lastTurn = transition;
  updateButtonsPressed(state);
  if (transition.playerChanges?.length > 0) {
    computeBlockLists(state);
  }
  return transition;
}

/**
 * @param {any} state
 * @returns {any | null}
 */
export function undoTurn(state) {
  const turn = state.undoStack.pop();
  if (!turn) {
    return null;
  }
  applyTurn(state, turn, "reverse");
  state.moveCount = turn.moveCountBefore;
  state.redoStack.push(turn);
  state.lastTurn = null;
  updateButtonsPressed(state);
  if (turn.playerChanges?.length > 0) {
    computeBlockLists(state);
  }
  // If this turn is part of a multi-player group, undo the rest too.
  var group = turn.mpGroup;
  if (group !== undefined) {
    var undone = 0;
    while (state.undoStack.length > 0) {
      var next = state.undoStack[state.undoStack.length - 1];
      if (next.mpGroup !== group) break;
      next = state.undoStack.pop();
      applyTurn(state, next, "reverse");
      state.moveCount = next.moveCountBefore;
      state.redoStack.push(next);
      undone++;
      if (next.playerChanges?.length > 0) computeBlockLists(state);
    }
    turn._mpUndoneExtra = undone;
  }
  return turn;
}

/**
 * @param {any} state
 * @returns {any | null}
 */
export function redoTurn(state) {
  const turn = state.redoStack.pop();
  if (!turn) {
    return null;
  }
  applyTurn(state, turn, "forward");
  state.moveCount = turn.moveCountAfter;
  state.undoStack.push(turn);
  state.lastTurn = turn;
  updateButtonsPressed(state);
  if (turn.playerChanges?.length > 0) {
    computeBlockLists(state);
  }
  return turn;
}

/**
 * @param {any} state
 * @returns {any | null}
 */
export function restartLevel(state) {
  const turn = {
    kind: "turn",
    isRestart: true,
    moveCountBefore: state.moveCount,
    moveCountAfter: 0,
    moves: [],
    playerChanges: [],
    command: "Restart",
    stateBefore: snapshotState(state)
  };

  for (const block of state.blocks) {
    if (
      block.outerLevel !== block.outerLevelStart ||
      block.xpos !== block.xposStart ||
      block.ypos !== block.yposStart ||
      block.flipH !== block.flipHStart
    ) {
      turn.moves.push({
        block,
        fromLevel: block.outerLevel,
        fromX: block.xpos,
        fromY: block.ypos,
        fromFlipH: block.flipH,
        toLevel: block.outerLevelStart,
        toX: block.xposStart,
        toY: block.yposStart,
        toFlipH: block.flipHStart,
        dx: signInt(block.xposStart - block.xpos),
        dy: signInt(block.yposStart - block.ypos)
      });
    }
    if (block.isPlayer !== block.isPlayerStart || block.playerOrder !== block.playerOrderStart) {
      turn.playerChanges.push({
        block,
        fromIsPlayer: block.isPlayer,
        toIsPlayer: block.isPlayerStart,
        fromPlayerOrder: block.playerOrder,
        toPlayerOrder: block.playerOrderStart
      });
    }
  }

  if (turn.moves.length === 0 && turn.playerChanges.length === 0) {
    return null;
  }

  applyTurn(state, turn, "forward");
  state.moveCount = 0;
  state.undoStack.push(turn);
  state.redoStack = [];
  state.lastTurn = turn;
  updateButtonsPressed(state);
  if (turn.playerChanges.length > 0) {
    computeBlockLists(state);
  }
  return turn;
}

/**
 * @param {any} state
 * @param {string[] | string} inputLog
 * @returns {{ finalState: any, timeline: Array<any> }}
 */
export function rebuildReplay(state, inputLog) {
  const commands = Array.isArray(inputLog) ? inputLog : inputLog.trim().split(/\s+/).filter(Boolean);
  const replayState = parseLevelText(state.sourceText, state.initialContext ?? { currentLevelName: state.currentLevelName, database: state.database });
  const timeline = [{ command: null, state: snapshotState(replayState) }];
  for (const command of commands) {
    runInputCommand(replayState, command);
    timeline.push({ command, state: snapshotState(replayState) });
  }
  return { finalState: replayState, timeline };
}

/**
 * @param {any} state
 * @param {any} turn
 * @param {"forward" | "reverse"} direction
 */
function applyTurn(state, turn, direction) {
  const moveFields =
    direction === "forward"
      ? {
          fromLevel: "fromLevel",
          fromX: "fromX",
          fromY: "fromY",
          fromFlipH: "fromFlipH",
          toLevel: "toLevel",
          toX: "toX",
          toY: "toY",
          toFlipH: "toFlipH"
        }
      : {
          fromLevel: "toLevel",
          fromX: "toX",
          fromY: "toY",
          fromFlipH: "toFlipH",
          toLevel: "fromLevel",
          toX: "fromX",
          toY: "fromY",
          toFlipH: "fromFlipH"
        };

  for (const move of turn.moves) {
    if (move.block.outerLevel?.blocks[move.block.ypos]?.[move.block.xpos] === move.block) {
      move.block.outerLevel.blocks[move.block.ypos][move.block.xpos] = null;
    }
  }
  for (const move of turn.moves) {
    move.block.outerLevel = move[moveFields.toLevel];
    move.block.xpos = move[moveFields.toX];
    move.block.ypos = move[moveFields.toY];
    move.block.flipH = move[moveFields.toFlipH];
    move.block.tempFlipH = move[moveFields.toFlipH];
    if (move[moveFields.fromFlipH] !== move[moveFields.toFlipH]) {
      move.block.fadeFlipH = true;
    }
    if (move.block.outerLevel) {
      move.block.outerLevel.blocks[move.block.ypos][move.block.xpos] = move.block;
    }
  }

  for (const change of turn.playerChanges) {
    change.block.isPlayer = direction === "forward" ? change.toIsPlayer : change.fromIsPlayer;
    change.block.drawIsPlayer = change.block.isPlayer;
    change.block.playerOrder = direction === "forward" ? change.toPlayerOrder : change.fromPlayerOrder;
  }

  if (turn.wentToInfZoneChanged) {
    state.wentToInfZone = direction === "forward" ? true : false;
  }
}

/**
 * @param {any} context
 * @param {any} block
 * @param {number} dx
 * @param {number} dy
 * @returns {boolean}
 */
function attemptToSlide(context, block, dx, dy) {
  if (context.cancelAllMovement) {
    return false;
  }
  const move = {
    block,
    moveType: "Slide",
    fromLevel: block.outerLevel,
    fromLevelBlock: getExitBlock(block.outerLevel),
    fromX: block.xpos,
    fromY: block.ypos,
    toLevel: block.outerLevel,
    toLevelBlock: getExitBlock(block.outerLevel),
    toX: block.xpos + dx,
    toY: block.ypos + dy,
    dx,
    dy,
    infExitNum: -1,
    infEnterNum: -1,
    infEaten: false,
    infEnterSourceBlock: null,
    shed: false
  };
  context.searchMoves.push(move);
  const result = attemptToMoveToSpot(context, block, block.outerLevel, move.toX, move.toY, dx, dy);
  if (!result && context.searchMoves[context.searchMoves.length - 1] === move) {
    context.searchMoves.pop();
  }
  return result;
}

/**
 * @param {any} context
 * @param {any} block
 * @param {any} targetLevel
 * @param {number} targetX
 * @param {number} targetY
 * @param {number} dx
 * @param {number} dy
 * @returns {boolean}
 */
function attemptToMoveToSpot(context, block, targetLevel, targetX, targetY, dx, dy) {
  if (context.searchMoves.length > 200) {
    context.cancelAllMovement = true;
    return false;
  }

  const searchMove = context.searchMoves[context.searchMoves.length - 1];
  if (searchMove.moveType === "Exit") {
    for (let index = 0; index < context.searchMoves.length - 1; index += 1) {
      const move = context.searchMoves[index];
      if (
        move.block === searchMove.block &&
        move.moveType === "Exit" &&
        move.fromLevel === searchMove.fromLevel &&
        move.dx === searchMove.dx
      ) {
        context.infExitUnwinding = true;
        context.infExitUnwindTo = index - 1;
        context.searchMoves.pop();
        return false;
      }
    }
  }

  if (searchMove.moveType === "Enter") {
    for (let index = 0; index < context.searchMoves.length - 1; index += 1) {
      const move = context.searchMoves[index];
      if (
        move.block === searchMove.block &&
        move.moveType === "Enter" &&
        move.toLevel === searchMove.toLevel &&
        move.toX === searchMove.toX &&
        move.toY === searchMove.toY
      ) {
        context.infEnterUnwinding = true;
        context.infEnterUnwindTo = index - 1;
        context.searchMoves.pop();
        return false;
      }
    }
  }

  if (searchMove.moveType === "Slide") {
    for (let index = 0; index < context.searchMoves.length - 1; index += 1) {
      const move = context.searchMoves[index];
      if (
        move.block === searchMove.block &&
        move.moveType === "Slide" &&
        (move.dx !== searchMove.dx || move.dy !== searchMove.dy)
      ) {
        context.searchMoves.pop();
        return false;
      }
    }
  }

  for (let index = 0; index < context.searchMoves.length - 1; index += 1) {
    if (sameSearchMove(searchMove, context.searchMoves[index])) {
      context.cancelAllMovement = true;
      context.searchMoves.pop();
      return false;
    }
  }

  if (block.subLevel === null && block.isPlayer) {
    for (let index = 0; index < context.searchMoves.length - 1; index += 1) {
      if (context.searchMoves[index].block !== block) {
        context.searchMoves.pop();
        return false;
      }
    }
  }

  if (block.subLevel === null && !block.isPlayer) {
    if (!context.state.innerPushEnabled) {
      context.searchMoves.pop();
      return false;
    }
    const exitBlock = getExitBlock(block.outerLevel);
    if (!exitBlock || !exitBlock.outerLevel) {
      context.searchMoves.pop();
      return false;
    }
    for (let index = context.searchMoves.length - 1; index >= 0; index -= 1) {
      const move = context.searchMoves[index];
      if (move.block !== block) {
        if (move.moveType !== "Enter") {
          break;
        }
        context.searchMoves.pop();
        return false;
      }
    }
    for (let index = 0; index < context.searchMoves.length - 1; index += 1) {
      if (context.searchMoves[index].block === exitBlock) {
        context.searchMoves.pop();
        return false;
      }
    }
    block.tempInnerPush = true;
    let innerDx = dx;
    if (exitBlock.flipH) {
      innerDx *= -1;
    }
    const pushed = attemptToSlide(context, exitBlock, innerDx, dy);
    if (pushed) {
      context.nudge = true;
      return true;
    }
    block.tempInnerPush = false;
    context.searchMoves.pop();
    return false;
  }

  if (!inBounds(context.state, targetLevel, targetX, targetY)) {
    let infExitNum = -1;
    let guard = 0;
    do {
      if (attemptToExit(context, block, targetLevel, infExitNum, dx, dy, targetX, targetY)) {
        return true;
      }
      if (!context.infExitUnwinding) {
        return false;
      }
      if (context.searchMoves.length - 1 !== context.infExitUnwindTo) {
        return false;
      }
      context.infExitUnwinding = false;
      context.infExitUnwindTo = -1;
      infExitNum += 1;
      guard += 1;
    } while (guard < 20);
    context.cancelAllMovement = true;
    return false;
  }

  const blockAtTarget = targetLevel.blocks[targetY][targetX];
  if (!blockAtTarget) {
    resolveMove(context, block, targetLevel, targetX, targetY, dx, dy);
    return true;
  }

  let movingTarget = null;
  for (const move of context.searchMoves) {
    if (move.block === blockAtTarget) {
      movingTarget = move;
      break;
    }
  }

  let blockAtTargetWithinInnerPushChain = false;
  if (movingTarget) {
    for (let index = context.searchMoves.length - 1; index >= 0; index -= 1) {
      const move = context.searchMoves[index];
      if (move.block.tempInnerPush) {
        blockAtTargetWithinInnerPushChain = true;
        break;
      }
      if (move.block === blockAtTarget) {
        break;
      }
    }
  }

  if (movingTarget && ((movingTarget.dx === dx && dx !== 0) || (movingTarget.dy === dy && dy !== 0)) && !blockAtTargetWithinInnerPushChain) {
    if (blockAtTarget.tempInnerPush) {
      context.searchMoves.pop();
      return false;
    }
    // C# picks the block just below blockAtTarget in the move stack as Interloper.
    let foundTarget = false;
    for (let index = context.searchMoves.length - 1; index >= 0; index -= 1) {
      const move = context.searchMoves[index];
      if (move.block === blockAtTarget) {
        foundTarget = true;
      } else if (foundTarget) {
        context.interloper = move.block;
        break;
      }
    }
    resolveMove(context, block, targetLevel, targetX, targetY, dx, dy);
    return true;
  }

  if (movingTarget && ((movingTarget.dx === -dx && dx !== 0) || (movingTarget.dy === -dy && dy !== 0))) {
    context.searchMoves.pop();
    return false;
  }

  const attemptPush = () => {
    if (blockAtTargetWithinInnerPushChain || context.infEnterUnwinding) {
      return false;
    }
    if (attemptToSlide(context, blockAtTarget, dx, dy)) {
      resolveMove(context, block, targetLevel, targetX, targetY, dx, dy);
      return true;
    }
    return false;
  };

  const attemptEnter = () => {
    if (blockAtTarget.subLevel === null) {
      return false;
    }
    if (attemptToEnter(context, block, blockAtTarget, -1, false, null, dx, dy)) {
      if (block.justEnteredArray === null) {
        setJustEnteredArray(context, block);
      }
      return true;
    }
    let infEnterNum = 0;
    let guard = 0;
    do {
      if (!handleInfEnterUnwind(context)) {
        return false;
      }
      let infEnterBlock = blockAtTarget.subLevel.infEnterBlocks[infEnterNum] ?? null;
      if (!infEnterBlock) {
        infEnterBlock = createInfEnterZone(context.state, blockAtTarget.subLevel, infEnterNum);
      }
      if (attemptToEnter(context, block, infEnterBlock, infEnterNum, false, blockAtTarget, dx, dy)) {
        if (block.justEnteredArray === null) {
          setJustEnteredArray(context, block);
          block.justEnteredArray[0] = blockAtTarget;
        }
        block.justInfEntered = true;
        return true;
      }
      infEnterNum += 1;
      guard += 1;
    } while (guard < 10);
    context.cancelAllMovement = true;
    return false;
  };

  const attemptEat = () => {
    if (context.infEnterUnwinding || blockAtTarget.subLevel === null || block.subLevel === null) {
      return false;
    }
    if (attemptToEnter(context, blockAtTarget, block, -1, false, null, -dx, -dy)) {
      if (blockAtTarget.justEnteredArray === null) {
        setJustEnteredArray(context, blockAtTarget);
      }
      resolveMove(context, block, targetLevel, targetX, targetY, dx, dy);
      return true;
    }
    let infEnterNum = 0;
    let guard = 0;
    do {
      if (!handleInfEnterUnwind(context)) {
        return false;
      }
      let infEnterBlock = block.subLevel.infEnterBlocks[infEnterNum] ?? null;
      if (!infEnterBlock) {
        infEnterBlock = createInfEnterZone(context.state, block.subLevel, infEnterNum);
      }
      if (attemptToEnter(context, blockAtTarget, infEnterBlock, infEnterNum, true, block, -dx, -dy)) {
        if (blockAtTarget.justEnteredArray === null) {
          setJustEnteredArray(context, blockAtTarget);
          blockAtTarget.justEnteredArray[0] = block;
        }
        blockAtTarget.justInfEntered = true;
        resolveMove(context, block, targetLevel, targetX, targetY, dx, dy);
        return true;
      }
      infEnterNum += 1;
      guard += 1;
    } while (guard < 10);
    context.cancelAllMovement = true;
    return false;
  };

  const attemptPossess = () => {
    if (context.infEnterUnwinding) {
      return false;
    }
    if (blockAtTarget.outerLevel?.infZone) {
      return false;
    }
    if (!block.isPlayer || !blockAtTarget.possessable || blockAtTarget.isPlayer) {
      return false;
    }
    for (let index = 0; index < context.searchMoves.length - 1; index += 1) {
      if (context.searchMoves[index].block !== block) {
        return false;
      }
    }
    context.nudge = true;
    context.possess = true;
    if (block.justEnteredArray === null) {
      setJustEnteredArray(context, block);
    }
    context.transition.playerChanges.push({
      block,
      fromIsPlayer: true,
      toIsPlayer: false,
      fromPlayerOrder: block.playerOrder,
      toPlayerOrder: blockAtTarget.playerOrder
    });
    context.transition.playerChanges.push({
      block: blockAtTarget,
      fromIsPlayer: blockAtTarget.isPlayer,
      toIsPlayer: true,
      fromPlayerOrder: blockAtTarget.playerOrder,
      toPlayerOrder: block.playerOrder
    });
    return true;
  };

  for (const attempt of context.state.attemptOrder) {
    if (attempt === Attempt.PUSH && attemptPush()) {
      return true;
    }
    if (attempt === Attempt.ENTER && attemptEnter()) {
      return true;
    }
    if (attempt === Attempt.EAT && attemptEat()) {
      return true;
    }
    if (attempt === Attempt.POSSESS && attemptPossess()) {
      return true;
    }
  }

  context.searchMoves.pop();
  return false;
}

/**
 * @param {any} context
 * @returns {boolean}
 */
function handleInfEnterUnwind(context) {
  if (!context.infEnterUnwinding) {
    return false;
  }
  if (context.searchMoves.length - 1 !== context.infEnterUnwindTo) {
    return false;
  }
  context.infEnterUnwinding = false;
  context.infEnterUnwindTo = -1;
  return true;
}

/**
 * Mirrors Movement.SetJustEnteredArray: collect the blocks this block entered
 * during the current move chain from innermost to outermost.
 *
 * @param {any} context
 * @param {any} block
 */
function setJustEnteredArray(context, block) {
  const entered = [];
  for (let index = context.searchMoves.length - 1; index >= 0; index -= 1) {
    const move = context.searchMoves[index];
    if (move.block === block && move.moveType === "Enter") {
      entered.push(move.toLevelBlock);
    }
  }
  block.justEnteredArray = entered.length > 0 ? entered : null;
}

/**
 * @param {any} context
 * @param {any} block
 * @param {any} toEnter
 * @param {number} infEnterNum
 * @param {boolean} infEaten
 * @param {any | null} infEnterSourceBlock
 * @param {number} dx
 * @param {number} dy
 * @returns {boolean}
 */
function attemptToEnter(context, block, toEnter, infEnterNum, infEaten, infEnterSourceBlock, dx, dy) {
  if (context.cancelAllMovement) {
    return false;
  }
  if (toEnter.outerLevel?.infZone && infEnterNum === -1) {
    return false;
  }
  if (toEnter.isSomeInfExitBlock) {
    return false;
  }

  let flipped = false;
  if (toEnter.tempFlipH) {
    dx *= -1;
    block.tempFlipH = !block.tempFlipH;
    flipped = true;
  }

  const [targetX, targetY] = computeEnterTargetPos(context, block, toEnter, dx, dy);
  let fromLevel;
  let fromLevelBlock;
  if (infEnterNum !== -1) {
    for (let index = context.searchMoves.length - 1; index >= 0; index -= 1) {
      const move = context.searchMoves[index];
      if (move.block === block) {
        fromLevel = move.toLevel;
        fromLevelBlock = getExitBlock(fromLevel);
        break;
      }
    }
  } else {
    fromLevel = toEnter.outerLevel;
    fromLevelBlock = getExitBlock(fromLevel);
  }

  const move = {
    block,
    moveType: "Enter",
    fromLevel,
    fromLevelBlock,
    fromX: toEnter.xpos - dx,
    fromY: toEnter.ypos - dy,
    toLevel: toEnter.subLevel,
    toLevelBlock: toEnter,
    toX: targetX,
    toY: targetY,
    dx,
    dy,
    infExitNum: -1,
    infEnterNum,
    infEaten,
    infEnterSourceBlock,
    shed: false
  };
  context.searchMoves.push(move);
  const success = attemptToMoveToSpot(context, block, toEnter.subLevel, targetX, targetY, dx, dy);
  if (!success && flipped) {
    block.tempFlipH = !block.tempFlipH;
  }
  if (!success && context.searchMoves[context.searchMoves.length - 1] === move) {
    context.searchMoves.pop();
  }
  return success;
}

/**
 * @param {any} context
 * @param {any} block
 * @param {any} toExit
 * @param {number} infExitNum
 * @param {number} dx
 * @param {number} dy
 * @param {number} oobX
 * @param {number} oobY
 * @returns {boolean}
 */
function attemptToExit(context, block, toExit, infExitNum, dx, dy, oobX, oobY) {
  if (context.cancelAllMovement) {
    return false;
  }
  let exitBlock = infExitNum !== -1 ? toExit.infExitBlocks[infExitNum] ?? null : getExitBlock(toExit);
  if (!exitBlock && infExitNum !== -1) {
    exitBlock = createInfExitZone(context.state, toExit, infExitNum);
  }
  if (!exitBlock || !exitBlock.outerLevel) {
    return false;
  }

  let flipped = false;
  if (exitBlock.flipH) {
    dx *= -1;
    block.tempFlipH = !block.tempFlipH;
    flipped = true;
  }

  const targetX = exitBlock.xpos + dx;
  const targetY = exitBlock.ypos + dy;
  const move = {
    block,
    moveType: "Exit",
    fromLevel: toExit,
    fromLevelBlock: exitBlock,
    fromX: oobX - dx,
    fromY: oobY - dy,
    toLevel: exitBlock.outerLevel,
    toLevelBlock: getExitBlock(exitBlock.outerLevel),
    toX: targetX,
    toY: targetY,
    dx,
    dy,
    infExitNum,
    infEnterNum: -1,
    infEaten: false,
    infEnterSourceBlock: null,
    shed: false
  };
  context.searchMoves.push(move);
  let success = attemptToMoveToSpot(context, block, exitBlock.outerLevel, targetX, targetY, dx, dy);

  if (context.state.shedEnabled && !success && !context.infExitUnwinding) {
    // C# Move is a struct: PushMove(move) copies the value. The original on the
    // stack keeps shed=false; the new copy gets shed=true.  JS uses references,
    // so we must create a fresh object and push it without mutating the original.
    const shedMove = { ...move, shed: true };
    context.searchMoves.push(shedMove);
    const outerLevel = exitBlock.outerLevel;
    const exitX = exitBlock.xpos;
    const exitY = exitBlock.ypos;
    success = attemptToSlide(context, exitBlock, -dx, -dy);
    if (success) {
      resolveMove(context, block, outerLevel, exitX, exitY, dx, dy);
    } else {
      if (context.searchMoves[context.searchMoves.length - 1] === shedMove) {
        context.searchMoves.pop();
      }
    }
  }

  if (!success && flipped) {
    block.tempFlipH = !block.tempFlipH;
  }
  if (!success && context.searchMoves[context.searchMoves.length - 1] === move) {
    context.searchMoves.pop();
  }
  return success;
}

/**
 * @param {any} context
 * @param {any} block
 * @param {any} toEnter
 * @param {number} dx
 * @param {number} dy
 * @returns {[number, number]}
 */
function computeEnterTargetPos(context, block, toEnter, dx, dy) {
  let t = 0.5;
  let firstExit = true;
  for (const move of context.searchMoves) {
    if (move.block !== block) {
      continue;
    }
    if (move.moveType === "Exit") {
      if (firstExit) {
        if (move.dx !== 0) {
          t = (move.fromY + 0.5) / move.fromLevel.height;
        } else if (move.dy !== 0) {
          t = (move.fromX + 0.5) / move.fromLevel.width;
        }
        firstExit = false;
      } else if (move.dx !== 0) {
        t = lerp(move.fromY / move.fromLevel.height, (move.fromY + 1) / move.fromLevel.height, t);
      } else if (move.dy !== 0) {
        t = lerp(move.fromX / move.fromLevel.width, (move.fromX + 1) / move.fromLevel.width, t);
      }
      if (move.dy !== 0 && move.fromLevelBlock?.flipH) {
        t = 1 - t;
      }
    } else if (move.moveType === "Enter") {
      if (move.dy !== 0 && move.toLevelBlock?.tempFlipH) {
        t = 1 - t;
      }
      if (move.dx !== 0) {
        t = inverseLerp(move.toY / move.toLevel.height, (move.toY + 1) / move.toLevel.height, t);
      } else if (move.dy !== 0) {
        t = inverseLerp(move.toX / move.toLevel.width, (move.toX + 1) / move.toLevel.width, t);
      }
    }
  }

  if (dy !== 0 && toEnter.tempFlipH) {
    t = 1 - t;
  }

  let targetX = 0;
  let targetY = 0;
  if (dx !== 0) {
    targetX = dx < 0 ? toEnter.subLevel.width - 1 : 0;
    targetY = Math.floor(t * toEnter.subLevel.height);
  } else {
    targetY = dy < 0 ? toEnter.subLevel.height - 1 : 0;
    targetX = Math.floor(t * toEnter.subLevel.width);
  }
  return [targetX, targetY];
}

/**
 * @param {any} context
 * @param {any} block
 * @param {any} toLevel
 * @param {number} toX
 * @param {number} toY
 * @param {number} dx
 * @param {number} dy
 */
function resolveMove(context, block, toLevel, toX, toY, dx, dy) {
  // Movement.ResolveMove turns the Interloper into a nudge instead of moving it across levels.
  if (block === context.interloper) {
    context.nudge = true;
  }
  if (context.nudge) {
    if (!context.resolvedMoves.has(block.id)) {
      const firstMove = context.searchMoves.find((move) => move.block === block) ?? null;
      context.resolvedMoves.set(block.id, {
        block,
        fromLevel: block.outerLevel,
        fromX: block.xpos,
        fromY: block.ypos,
        fromFlipH: block.flipH,
        toLevel: block.outerLevel,
        toX: block.xpos,
        toY: block.ypos,
        toFlipH: block.flipH,
        dx: firstMove?.dx ?? dx,
        dy: firstMove?.dy ?? dy,
        moveType: "Nudge",
        trail: collectMoveTrail(context, block),
        nudge: true,
        animKind: "NUDGE",
        animType: "NUDGE",
        animXOffset: 0,
        animYOffset: 0,
        animXScale: 1,
        animYScale: 1,
        drawXOffsetStart: 0,
        drawYOffsetStart: 0,
        drawXScaleStart: 1,
        drawYScaleStart: 1
      });
    }
    return;
  }

  const trail = collectMoveTrail(context, block);
  const moveType = trail.length > 0 ? trail[trail.length - 1].moveType : null;
  const projection = computeProjectionFromTrail(trail) ?? { dx: 0, dy: 0, xscale: 1, yscale: 1 };
  const cameraProjection = block.isPlayer && block.outerLevel !== toLevel
    ? computeProjectionParentFromTrail(trail)
    : null;
  const animKind = trail.some((step) => step.moveType === "Enter" || step.moveType === "Exit") ? "ENTER_EXIT" : "NORMAL";
  const existing = context.resolvedMoves.get(block.id);
  if (cameraProjection) {
    context.transition.cameraProjection = cameraProjection;
    context.transition.camX = cameraProjection.dx;
    context.transition.camY = cameraProjection.dy;
    context.transition.camXS = cameraProjection.xscale;
    context.transition.camYS = cameraProjection.yscale;
    context.transition.cameraMovedThisTurn = true;
  }
  if (block.isPlayer && block.outerLevel !== toLevel && block.tempFlipH !== block.flipH) {
    context.transition.cameraFlipChanged = true;
  }
  if (existing) {
    existing.toLevel = toLevel;
    existing.toX = toX;
    existing.toY = toY;
    existing.toFlipH = block.tempFlipH;
    existing.dx = dx;
    existing.dy = dy;
    existing.moveType = moveType;
    existing.trail = trail;
    existing.animXOffset = projection.dx;
    existing.animYOffset = projection.dy;
    existing.animXScale = projection.xscale;
    existing.animYScale = projection.yscale;
    existing.drawXOffsetStart = projection.dx;
    existing.drawYOffsetStart = projection.dy;
    existing.drawXScaleStart = projection.xscale;
    existing.drawYScaleStart = projection.yscale;
    existing.animKind = animKind;
    existing.animType = animKind;
    existing.nudge = false;
  } else {
    context.resolvedMoves.set(block.id, {
      block,
      fromLevel: block.outerLevel,
      fromX: block.xpos,
      fromY: block.ypos,
      fromFlipH: block.flipH,
      toLevel,
      toX,
      toY,
      toFlipH: block.tempFlipH,
      dx,
      dy,
      moveType,
      trail,
      nudge: false,
      animKind,
      animType: animKind,
      animXOffset: projection.dx,
      animYOffset: projection.dy,
      animXScale: projection.xscale,
      animYScale: projection.yscale,
      drawXOffsetStart: projection.dx,
      drawYOffsetStart: projection.dy,
      drawXScaleStart: projection.xscale,
      drawYScaleStart: projection.yscale
    });
  }

  if (!context.state.wentToInfZone && toLevel.infZone) {
    context.wentToInfZoneChanged = true;
  }
}


/**
 * Mirrors Projection.ComputeAnimLength for the subset represented in JS turns.
 * Any nonzero enter/exit stack, or even a balanced enter/exit stack, uses the
 * configured enter length; pure slides use Projection.SlideLength = 0.1s.
 *
 * @param {Array<any>} moves
 * @param {any} state
 * @returns {number}
 */
function computeAnimLengthSeconds(moves, state) {
  const balanceByBlockId = new Map();
  let sawEnterOrExit = false;
  for (const move of moves ?? []) {
    for (const step of move.trail ?? []) {
      if (step.moveType !== "Enter" && step.moveType !== "Exit") {
        continue;
      }
      sawEnterOrExit = true;
      const blockId = step.block?.id ?? move.block?.id;
      if (blockId == null) {
        continue;
      }
      const delta = step.moveType === "Enter" ? 1 : -1;
      balanceByBlockId.set(blockId, (balanceByBlockId.get(blockId) ?? 0) + delta);
    }
  }

  if (sawEnterOrExit) {
    const lengths = [0.5, 1 / 3, 0.25, 0.75];
    const index = state?.prefs?.enterSpeedIndex ?? 0;
    return lengths[index] ?? lengths[0];
  }

  return 0.1;
}

/**
 * Render-only phantoms mirror the transient Phantom objects C# creates during
 * ResolveMove. They are attached to the turn, not to canonical level state.
 *
 * @param {Array<any>} moves
 * @returns {Array<any>}
 */
function buildRenderPhantoms(moves) {
  const phantoms = [];
  for (const move of moves) {
    if (move.nudge || !Array.isArray(move.trail)) {
      continue;
    }
    const firstStep = move.trail[0] ?? move;
    const firstDx = firstStep.dx ?? move.dx ?? 0;
    const firstDy = firstStep.dy ?? move.dy ?? 0;
    const exitStep = move.trail.find((step) => step.moveType === "Exit");
    if (exitStep?.fromLevel?.blocksWithThisAsTheirSubLevel?.length > 0) {
      const infExitNum = exitStep.infExitNum ?? -1;
      phantoms.push({
        kind: "exit",
        block: move.block,
        outerLevel: exitStep.fromLevel,
        xpos: exitStep.fromX,
        ypos: exitStep.fromY,
        exitedFrom: infExitNum >= 0 ? exitStep.fromLevel.infExitBlocks?.[infExitNum] ?? null : getExitBlock(exitStep.fromLevel),
        exiting: true,
        exitingDX: firstDx,
        exitingDY: firstDy,
        xFrom: 0,
        yFrom: 0,
        xTo: firstDx !== 0 ? firstDx : 0,
        yTo: firstDy !== 0 ? firstDy : 0,
        xScaleFrom: 1,
        yScaleFrom: 1,
        xScaleTo: 1,
        yScaleTo: 1
      });
    }

    const infEnterStep = move.trail.find((step) => step.moveType === "Enter" && (step.infEnterNum ?? -1) !== -1);
    if (infEnterStep) {
      const xTo = (move.animXOffset ?? 0) !== 0 ? -Math.sign(move.animXOffset) / 2 : 0;
      const yTo = (move.animYOffset ?? 0) !== 0 ? -Math.sign(move.animYOffset) / 2 : 0;
      phantoms.push({
        kind: "shrink",
        block: move.block,
        outerLevel: move.fromLevel,
        xpos: move.fromX,
        ypos: move.fromY,
        xFrom: 0,
        yFrom: 0,
        xTo,
        yTo,
        xScaleFrom: 1,
        yScaleFrom: 1,
        xScaleTo: 0,
        yScaleTo: 0
      });
    }
  }
  return phantoms;
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
 * Mirrors Projection.ComputeProjectionParent in screen-space coordinates.
 *
 * @param {Array<any>} trail
 * @returns {{ xscale: number, yscale: number, dx: number, dy: number } | null}
 */
function computeProjectionParentFromTrail(trail) {
  if (!Array.isArray(trail) || trail.length === 0) {
    return null;
  }
  if (trail.length === 1 && trail[0].moveType === "Slide") {
    return { xscale: 1, yscale: 1, dx: 0, dy: 0 };
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
    if (move.moveType === "Enter") {
      const block = move.toLevelBlock;
      const fromLevel = move.fromLevel;
      if (!block || !fromLevel) {
        return null;
      }
      if (block.flipH) {
        flipSign *= -1;
      }
      dx += (block.xpos - (fromLevel.width - 1) / 2) / xscale * flipSign;
      dy += (block.ypos - (fromLevel.height - 1) / 2) / yscale;
      xscale /= fromLevel.width;
      yscale /= fromLevel.height;
    } else if (move.moveType === "Exit") {
      const toLevel = move.toLevel;
      const fromLevelBlock = move.fromLevelBlock;
      if (!toLevel || !fromLevelBlock) {
        return null;
      }
      xscale *= toLevel.width;
      yscale *= toLevel.height;
      dx -= (fromLevelBlock.xpos - (toLevel.width - 1) / 2) / xscale * flipSign;
      dy -= (fromLevelBlock.ypos - (toLevel.height - 1) / 2) / yscale;
      if (getExitBlock(move.fromLevel)?.flipH) {
        flipSign *= -1;
      }
    }
  }

  const baseLevel = moves.find((move) => move.fromLevel)?.fromLevel ?? null;
  if (!baseLevel) {
    return null;
  }
  xscale *= baseLevel.camZoomFactor ?? 1;
  yscale *= baseLevel.camZoomFactor ?? 1;
  return { xscale, yscale, dx, dy };
}

/**
 * Mirrors Projection.ComputeProjection in screen-space coordinates.
 *
 * @param {Array<any>} trail
 * @returns {{ xscale: number, yscale: number, dx: number, dy: number } | null}
 */
function computeProjectionFromTrail(trail) {
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
 * @param {Array<any>} changes
 * @returns {Array<any>}
 */
function dedupePlayerChanges(changes) {
  /** @type {Map<number, any>} */
  const map = new Map();
  for (const change of changes) {
    map.set(change.block.id, change);
  }
  return [...map.values()];
}

/**
 * @param {any} left
 * @param {any} right
 * @returns {boolean}
 */
function sameSearchMove(left, right) {
  return (
    left.block === right.block &&
    left.moveType === right.moveType &&
    left.fromLevel === right.fromLevel &&
    left.fromX === right.fromX &&
    left.fromY === right.fromY &&
    left.toLevel === right.toLevel &&
    left.toX === right.toX &&
    left.toY === right.toY &&
    left.dx === right.dx &&
    left.dy === right.dy &&
    (left.infExitNum ?? -1) === (right.infExitNum ?? -1) &&
    (left.infEnterNum ?? -1) === (right.infEnterNum ?? -1) &&
    Boolean(left.infEaten) === Boolean(right.infEaten)
  );
}

/**
 * @param {any} context
 * @param {any} block
 * @returns {Array<any>}
 */
function collectMoveTrail(context, block) {
  return context.searchMoves
    .filter((move) => move.block === block)
    .map((move) => ({
      moveType: move.moveType,
      fromLevel: move.fromLevel,
      fromLevelId: move.fromLevel?.id ?? null,
      fromLevelBlock: move.fromLevelBlock,
      fromLevelBlockId: move.fromLevelBlock?.id ?? null,
      toLevel: move.toLevel,
      toLevelId: move.toLevel?.id ?? null,
      toLevelBlock: move.toLevelBlock,
      toLevelBlockId: move.toLevelBlock?.id ?? null,
      fromX: move.fromX,
      fromY: move.fromY,
      toX: move.toX,
      toY: move.toY,
      dx: move.dx,
      dy: move.dy,
      infEnterNum: move.infEnterNum ?? -1,
      infExitNum: move.infExitNum ?? -1,
      infEaten: Boolean(move.infEaten),
      shed: Boolean(move.shed),
      infEnterSourceBlock: move.infEnterSourceBlock ?? null,
      infEnterSourceBlockId: move.infEnterSourceBlock?.id ?? null
    }));
}

import { runInputCommand } from "./engine.js";
import { snapshotState } from "./model.js";

/**
 * @param {any} level
 * @returns {any}
 */
function serializeLevel(level) {
  if (!level) {
    return null;
  }
  return {
    id: level.id,
    width: level.width,
    height: level.height,
    infZone: Boolean(level.infZone)
  };
}

/**
 * @param {any} block
 * @returns {any}
 */
function serializeBlock(block) {
  if (!block) {
    return null;
  }
  return {
    id: block.id,
    kind: block.kind,
    outerLevelId: block.outerLevel?.id ?? null,
    subLevelId: block.subLevel?.id ?? null,
    x: block.xpos,
    y: block.ypos,
    isPlayer: Boolean(block.isPlayer),
    playerOrder: block.playerOrder,
    flipH: Boolean(block.flipH)
  };
}

/**
 * @param {any} move
 * @returns {any}
 */
function serializeMove(move) {
  return {
    blockId: move.block.id,
    moveType: move.moveType ?? null,
    from: {
      levelId: move.fromLevel?.id ?? null,
      x: move.fromX,
      y: move.fromY,
      flipH: Boolean(move.fromFlipH)
    },
    to: {
      levelId: move.toLevel?.id ?? null,
      x: move.toX,
      y: move.toY,
      flipH: Boolean(move.toFlipH)
    },
    dx: move.dx,
    dy: move.dy,
    trail: (move.trail ?? []).map((step) => ({
      moveType: step.moveType,
      fromLevelId: step.fromLevelId,
      toLevelId: step.toLevelId,
      fromX: step.fromX,
      fromY: step.fromY,
      toX: step.toX,
      toY: step.toY,
      dx: step.dx,
      dy: step.dy,
      infEnterNum: step.infEnterNum,
      infExitNum: step.infExitNum,
      infEaten: Boolean(step.infEaten),
      shed: Boolean(step.shed)
    }))
  };
}

/**
 * @param {any} transition
 * @returns {any | null}
 */
export function serializeTransition(transition) {
  if (!transition) {
    return null;
  }
  return {
    kind: transition.kind ?? "turn",
    command: transition.command ?? null,
    isRestart: Boolean(transition.isRestart),
    moveCountBefore: transition.moveCountBefore,
    moveCountAfter: transition.moveCountAfter,
    wentToInfZoneChanged: Boolean(transition.wentToInfZoneChanged),
    moves: (transition.moves ?? []).map(serializeMove),
    playerChanges: (transition.playerChanges ?? []).map((change) => ({
      blockId: change.block.id,
      fromIsPlayer: Boolean(change.fromIsPlayer),
      toIsPlayer: Boolean(change.toIsPlayer),
      fromPlayerOrder: change.fromPlayerOrder,
      toPlayerOrder: change.toPlayerOrder
    }))
  };
}

/**
 * @param {any} state
 * @returns {any}
 */
export function serializeStateSummary(state) {
  return {
    snapshot: snapshotState(state),
    focusBlock: serializeBlock(state.focusBlock),
    players: state.playerBlocks.map(serializeBlock),
    currentLevelName: state.currentLevelName,
    moveCount: state.moveCount,
    buttonsSatisfied: Boolean(state.buttonsSatisfied),
    finishesSatisfied: Boolean(state.finishesSatisfied),
    winning: Boolean(state.winning),
    levels: state.levels.map(serializeLevel)
  };
}

/**
 * @param {any} state
 * @param {string[] | string} commands
 * @returns {{ initialState: any, steps: Array<any>, finalState: any }}
 */
export function runCommandScript(state, commands) {
  const sequence = Array.isArray(commands) ? commands : commands.trim().split(/\s+/).filter(Boolean);
  const initialState = serializeStateSummary(state);
  const steps = [];

  for (const command of sequence) {
    const transition = runInputCommand(state, command);
    steps.push({
      command,
      changed: Boolean(transition),
      transition: serializeTransition(transition),
      stateAfter: serializeStateSummary(state)
    });
  }

  return {
    initialState,
    steps,
    finalState: serializeStateSummary(state)
  };
}

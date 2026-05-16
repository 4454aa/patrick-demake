import { runInputCommand } from "../core/engine.js";
import { localize } from "../parser/localization.js";
import { loadGameDatabase, loadLevelText } from "../parser/resources.js";
import { parseLevelText } from "../parser/level.js";
import { CanvasRenderer, ENTER_LENGTH } from "../render/canvas-renderer.js";
import {
  applyCustomLevelsToDatabase,
  createCustomLevel,
  exportCustomLevelPack,
  extractLevelTextsFromZipFile,
  importCustomLevelPack,
  isParafoxLevelText,
  loadCustomLevels,
  mergeCustomLevels,
  nameFromFileName,
  removeCustomLevel,
  saveCustomLevels
} from "./custom-levels.js";
import {
  RECORD_SOURCE_CUSTOM,
  RECORD_SOURCE_SHIPPED,
  deleteRecordsForLevel,
  deriveReplayInputLog,
  exportRecords,
  getRecord,
  hasHashMismatchRecord,
  importRecords,
  loadRecords,
  mergeRecords,
  saveRecords,
  upsertRecord
} from "./records.js";

const PREVIEW_CYCLE_MS = 2400;

var _thumbCache = new Map();
var _thumbSheet = null;
var _thumbManifest = null;
var _thumbReady = Promise.all([
  fetch("/game-data/level_thumbnails-manifest.json")
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null),
  loadImage("/game-data/level_thumbnails-sheet.png")
]).then(([manifest, image]) => {
  _thumbManifest = manifest;
  _thumbSheet = image;
});

/**
 * @param {string} src
 * @returns {Promise<HTMLImageElement | null>}
 */
function loadImage(src) {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = src;
  });
}

/**
 * @param {string} levelName
 * @returns {string}
 */
function _getThumbSrc(levelName) {
  if (_thumbCache.has(levelName)) {
    return _thumbCache.get(levelName);
  }
  if (!_thumbSheet || !_thumbManifest) {
    return "";
  }
  const entry = _thumbManifest[`${levelName}.png`];
  if (!entry) {
    return "";
  }
  const canvas = document.createElement("canvas");
  canvas.width = entry.w;
  canvas.height = entry.h;
  const context = canvas.getContext("2d");
  if (!context) {
    return "";
  }
  context.drawImage(_thumbSheet, entry.x, entry.y, entry.w, entry.h, 0, 0, entry.w, entry.h);
  const url = canvas.toDataURL();
  _thumbCache.set(levelName, url);
  return url;
}

/**
 * @param {HTMLImageElement} image
 * @param {string} src
 */
function setImageSrc(image, src) {
  if (!src) {
    image.hidden = true;
    image.removeAttribute("src");
    image.alt = "";
    return;
  }
  image.hidden = false;
  if (image.getAttribute("src") !== src) {
    image.src = src;
  }
}

/**
 * @param {Map<string, Map<string, string>>} localization
 * @returns {string}
 */
function resolvePreferredLanguage(localization) {
  if (localization.has("ZHCN")) {
    return "ZHCN";
  }
  return localization.has("EN") ? "EN" : [...localization.keys()][0] ?? "EN";
}

/**
 * @param {HTMLElement} app
 * @returns {Promise<void>}
 */
export async function boot(app) {
  app.innerHTML = createLayout();
  const elements = getElements(app);
  const database = await loadGameDatabase();
  const customLevels = loadCustomLevels(globalThis.localStorage);
  applyCustomLevelsToDatabase(database, customLevels);
  const records = loadRecords(globalThis.localStorage);
  const renderer = new CanvasRenderer(elements.canvas);
  const language = resolvePreferredLanguage(database.localization);
  await _thumbReady;

  const controller = {
    database,
    language,
    records,
    customLevels,
    solvedCount: 0,
    renderer,
    currentPageIndex: 0,
    currentState: null,
    currentLevelName: null,
    currentLevelText: "",
    sessionInputLog: [],
    replay: {
      active: false,
      state: null,
      step: 0,
      playing: false,
      timer: 0,
      speed: 1
    },
    animation: null,
    previewLevelName: database.pages[0]?.entries[0]?.levelName ?? null,
    previewLocked: false,
    previewLastAdvanceAt: performance.now(),
    pendingLevelName: null,
    loadErrorMessage: ""
  };
  updateSolvedCount(controller);

  elements.prevPage.addEventListener("click", () => {
    setCurrentPage(controller, elements, controller.currentPageIndex - 1);
  });

  elements.nextPage.addEventListener("click", () => {
    setCurrentPage(controller, elements, controller.currentPageIndex + 1);
  });

  const handlePageJump = () => attemptPageJump(controller, elements);
  elements.pageJump.addEventListener("change", handlePageJump);
  elements.pageJump.addEventListener("blur", () => syncPageJumpInput(controller, elements));
  elements.pageJumpButton.addEventListener("click", handlePageJump);
  elements.pageJump.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") {
      return;
    }
    event.preventDefault();
    handlePageJump();
  });

  elements.undo.addEventListener("click", () => handleCommand(controller, elements, "Z"));
  elements.redo.addEventListener("click", () => handleCommand(controller, elements, "Y"));
  elements.restart.addEventListener("click", () => handleCommand(controller, elements, "Restart"));
  elements.backToLive.addEventListener("click", () => {
    controller.replay.active = false;
    controller.replay.playing = false;
    renderGame(controller, elements);
  });

  elements.replayPlay.addEventListener("click", () => {
    if (!controller.replay.active) {
      seekReplay(controller, elements, 0);
    }
    controller.replay.playing = !controller.replay.playing;
    controller.replay.timer = performance.now();
    renderGame(controller, elements);
  });

  elements.replayStep.addEventListener("click", () => {
    if (!controller.replay.active) {
      seekReplay(controller, elements, 0);
    }
    seekReplay(controller, elements, controller.replay.step + 1);
  });

  elements.replayReset.addEventListener("click", () => {
    seekReplay(controller, elements, 0);
  });

  elements.replayDeleteRecord.addEventListener("click", () => {
    const entry = getCurrentEntry(controller);
    if (entry) {
      deleteLevelRecords(controller, elements, entry, elements.saveStatus);
    }
  });

  elements.replayRange.addEventListener("input", () => {
    if (!controller.replay.active) {
      seekReplay(controller, elements, 0);
    }
    seekReplay(controller, elements, Number.parseInt(elements.replayRange.value, 10));
  });

  elements.replaySpeed.addEventListener("change", () => {
    controller.replay.speed = Number.parseFloat(elements.replaySpeed.value);
  });

  elements.saveExport.addEventListener("click", () => {
    const json = exportRecords(controller.records);
    downloadText(json, `patrick-demake-records-${new Date().toISOString().slice(0, 10)}.json`, "application/json");
    elements.saveStatus.textContent = `已导出 ${controller.records.size} 条记录`;
  });

  elements.saveImport.addEventListener("click", () => {
    elements.saveImportFile.click();
  });

  elements.saveImportFile.addEventListener("change", () => {
    const file = elements.saveImportFile.files?.[0];
    if (!file) {
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const text = /** @type {string} */ (reader.result);
      const { records: imported, errors } = importRecords(text);
      if (errors.length > 0) {
        elements.saveStatus.textContent = `导入失败：${errors.join("; ")}`;
        return;
      }
      const result = mergeRecords(controller.records, imported);
      controller.records = result.merged;
      saveRecords(globalThis.localStorage, controller.records);
      updateSolvedCount(controller);
      elements.saveStatus.textContent = `导入完成：新增 ${result.imported} · 更新 ${result.updated} · 跳过 ${result.skipped}`;
      renderSelector(controller, elements);
      renderGame(controller, elements);
    };
    reader.readAsText(file);
    elements.saveImportFile.value = "";
  });

  elements.customImport.addEventListener("click", () => {
    elements.customImportFile.click();
  });

  elements.customImportFile.addEventListener("change", () => {
    void importCustomLevelFiles(controller, elements);
  });

  elements.customExport.addEventListener("click", () => {
    if (controller.customLevels.length === 0) {
      elements.customStatus.textContent = "没有可导出的自定义关卡";
      return;
    }
    const json = exportCustomLevelPack(controller.customLevels);
    downloadText(json, `patrick-demake-custom-levels-${new Date().toISOString().slice(0, 10)}.json`, "application/json");
    elements.customStatus.textContent = `已导出 ${controller.customLevels.length} 个自定义关卡`;
  });

  window.addEventListener("keydown", (event) => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target?.matches("input, select, textarea")) {
      return;
    }
    if (controller.replay.active) {
      return;
    }
    const key = event.key.toLowerCase();
    const command =
      key === "arrowup" || key === "w"
        ? "U"
        : key === "arrowdown" || key === "s"
          ? "D"
          : key === "arrowleft" || key === "a"
            ? "L"
            : key === "arrowright" || key === "d"
              ? "R"
              : key === "z"
                ? "Z"
                : key === "y"
                  ? "Y"
                  : key === "r"
                    ? "Restart"
                    : null;
    if (!command) {
      return;
    }
    event.preventDefault();
    handleCommand(controller, elements, command);
  });

  app.addEventListener("click", (event) => {
    const target = /** @type {HTMLElement | null} */ (event.target instanceof HTMLElement ? event.target : null);
    if (!target || !controller.previewLocked) {
      return;
    }
    if (target.closest(".level-button") || target.closest(".preview-card") || target.closest(".page-controls") || target.closest(".custom-level-tools")) {
      return;
    }
    unlockPreview(controller);
    renderSelector(controller, elements);
    renderGame(controller, elements);
  });

  const frame = () => {
    maybeAdvancePreview(controller, elements);
    controller.renderer.resize();
    renderCanvas(controller, elements);

    if (controller.replay.active && controller.replay.playing) {
      const record = getCurrentRecord(controller);
      if (record && performance.now() - controller.replay.timer > 280 / controller.replay.speed) {
        controller.replay.timer = performance.now();
        if (controller.replay.step < record.inputLog.length) {
          seekReplay(controller, elements, controller.replay.step + 1);
        } else {
          controller.replay.playing = false;
          renderGame(controller, elements);
        }
      }
    }

    if (controller.animation && performance.now() - controller.animation.startedAt > controller.animation.duration) {
      controller.animation = null;
    }

    requestAnimationFrame(frame);
  };

  renderSelector(controller, elements);
  renderGame(controller, elements);
  requestAnimationFrame(frame);
}

/**
 * @param {any} controller
 * @param {any} elements
 * @param {number} pageIndex
 */
function setCurrentPage(controller, elements, pageIndex) {
  const length = controller.database.pages.length;
  if (length === 0) {
    return;
  }
  controller.currentPageIndex = (pageIndex + length) % length;
  unlockPreview(controller);
  controller.previewLevelName = controller.database.pages[controller.currentPageIndex].entries[0]?.levelName ?? null;
  renderSelector(controller, elements);
  renderGame(controller, elements);
}

/**
 * @param {any} controller
 * @param {any} elements
 * @param {string} levelName
 */
async function loadLevel(controller, elements, levelName) {
  controller.currentLevelName = levelName;
  controller.previewLevelName = levelName;
  controller.previewLocked = true;
  controller.previewLastAdvanceAt = performance.now();
  controller.pendingLevelName = levelName;
  controller.loadErrorMessage = "";
  controller.currentLevelText = "";
  controller.currentState = null;
  controller.sessionInputLog = [];
  controller.replay.active = false;
  controller.replay.state = null;
  controller.replay.step = 0;
  controller.replay.playing = false;
  controller.animation = null;
  renderSelector(controller, elements);
  renderGame(controller, elements);

  try {
    controller.currentLevelText = await loadLevelText(fetch, levelName, controller.database);
    controller.currentState = parseLevelText(controller.currentLevelText, {
      currentLevelName: levelName,
      database: controller.database,
      language: controller.language
    });
    controller.loadErrorMessage = "";
  } catch (error) {
    controller.currentLevelText = "";
    controller.currentState = null;
    controller.loadErrorMessage = error instanceof Error ? error.message : String(error);
  } finally {
    if (controller.pendingLevelName === levelName) {
      controller.pendingLevelName = null;
    }
    renderSelector(controller, elements);
    renderGame(controller, elements);
  }
}

/**
 * @param {any} controller
 * @param {any} elements
 * @param {string} command
 */
function handleCommand(controller, elements, command) {
  if (!controller.currentState) {
    return;
  }

  if (controller.animation && (command === "U" || command === "D" || command === "L" || command === "R")) {
    return;
  }

  // C# Movement.Impulse: bool flipH2 = Draw.FlipH; FromCameraFlipH = Draw.FlipH;
  const cameraFlipHBefore = controller.renderer.cameraFlipH;

  controller.sessionInputLog.push(command);
  const turn = runInputCommand(controller.currentState, command);

  if (turn) {
    const hasEnterOrExit = turn.moves?.some((move) =>
      move.trail?.some((trailStep) => trailStep.moveType === "Enter" || trailStep.moveType === "Exit")
    );
    const baseDuration = controller.currentState.prefs.moveDelay * 2.2;
    controller.animation = {
      turn,
      direction: command === "Z" ? "reverse" : "forward",
      startedAt: performance.now(),
      duration: hasEnterOrExit ? ENTER_LENGTH * 1000 : baseDuration
    };

    // C# Movement.cs:200 — after TurnCompleted (which applies block.FlipH = toFlipH):
    //   if (Draw.FlipH != flipH2) { dxLast *= -1; }
    // ResolveMove sets ToCameraFlipH = !Draw.FlipH when tempFlipH != block.FlipH.
    // TurnCompleted → DoRedo applies Draw.FlipH = ToCameraFlipH.
    // So: if player's flip state changed, toggle cameraFlipH (immediate, matching C#).
    if (command !== "Z" && command !== "Y" && command !== "Restart") {
      const cameraFlipChanged = Boolean(turn.cameraFlipChanged);
      if (cameraFlipChanged) {
        controller.renderer.cameraFlipH = !controller.renderer.cameraFlipH;
      }
    }

    // Store camera state for undo/redo (C# FromCameraFlipH/ToCameraFlipH).
    turn.fromCameraFlipH = cameraFlipHBefore;
    turn.toCameraFlipH = controller.renderer.cameraFlipH;
  }

  // C# UndoManager: Undo → Draw.FlipH = t.FromCameraFlipH; Redo → Draw.FlipH = t.ToCameraFlipH;
  if (command === "Z" && turn?.fromCameraFlipH !== undefined) {
    controller.renderer.cameraFlipH = turn.fromCameraFlipH;
  } else if (command === "Y" && turn?.toCameraFlipH !== undefined) {
    controller.renderer.cameraFlipH = turn.toCameraFlipH;
  } else if (command === "Restart") {
    controller.renderer.cameraFlipH = false;
  }

  if (controller.currentState.winning) {
    const entry = getCurrentEntry(controller);
    const replayInputLog = deriveReplayInputLog(controller.currentState);
    const result = upsertRecord(controller.records, {
      levelId: entry?.levelId ?? controller.currentLevelName,
      levelName: controller.currentLevelName,
      displayName: entry ? formatPuzzleTitle(controller, entry) : controller.currentLevelName,
      source: entry?.source === RECORD_SOURCE_CUSTOM ? RECORD_SOURCE_CUSTOM : RECORD_SOURCE_SHIPPED,
      levelHash: entry?.levelHash ?? null,
      bestMoveCount: replayInputLog.length,
      inputLog: replayInputLog,
      inputCount: replayInputLog.length,
      version: controller.currentState.recordsVersion
    });
    if (result.updated) {
      saveRecords(globalThis.localStorage, controller.records);
      updateSolvedCount(controller);
      renderSelector(controller, elements);
    }
  }

  renderGame(controller, elements);
}

/**
 * @param {any} controller
 * @param {any} elements
 * @param {number} step
 */
function seekReplay(controller, elements, step) {
  const record = getCurrentRecord(controller);
  if (!record || !controller.currentLevelText) {
    return;
  }

  controller.replay.active = true;
  controller.replay.step = Math.max(0, Math.min(step, record.inputLog.length));
  controller.replay.state = parseLevelText(controller.currentLevelText, {
    currentLevelName: controller.currentLevelName,
    database: controller.database,
    language: controller.language
  });

  for (let index = 0; index < controller.replay.step; index += 1) {
    runInputCommand(controller.replay.state, record.inputLog[index]);
  }

  renderGame(controller, elements);
}

/**
 * @param {any} controller
 * @param {any} elements
 */
function renderSelector(controller, elements) {
  const page = controller.database.pages[controller.currentPageIndex];
  if (!page) {
    elements.pageLabel.textContent = "没有关卡";
    elements.selectorSummary.textContent = "";
    elements.levelGrid.innerHTML = "";
    renderPreview(controller, elements);
    return;
  }
  const solvedOnPage = page.entries.filter((entry) => getRecordForEntry(controller.records, entry)).length;
  const pageAreaLabel = resolveAreaLabel(controller, page.areaLocalizationId, page.pageKey);
  syncPageJumpInput(controller, elements);
  elements.pageLabel.textContent = `第 ${controller.currentPageIndex + 1} / ${controller.database.pages.length} 页 · ${pageAreaLabel}${page.sequenceCount > 1 ? ` ${page.sequenceIndex}` : ""}`;
  elements.selectorSummary.textContent = `本页已记录 ${solvedOnPage} / ${page.entries.length} · 全部已记录 ${controller.solvedCount} / ${controller.database.puzzleEntries.length}${page.custom ? " · 自定义关卡不显示缩略图" : controller.previewLocked ? " · 预览已锁定" : " · 预览自动轮播中"}`;
  elements.previewCard.classList.toggle("locked", controller.previewLocked);
  elements.levelGrid.innerHTML = "";

  for (const entry of page.entries) {
    if (entry.custom) {
      elements.levelGrid.appendChild(createCustomLevelCard(controller, elements, entry));
    } else {
      elements.levelGrid.appendChild(createOfficialLevelButton(controller, elements, entry));
    }
  }

  renderPreview(controller, elements);
}

/**
 * @param {any} controller
 * @param {any} elements
 * @param {any} entry
 * @returns {HTMLButtonElement}
 */
function createOfficialLevelButton(controller, elements, entry) {
  const record = getRecordForEntry(controller.records, entry);
  const button = document.createElement("button");
  button.className = "level-button";
  button.classList.toggle("active", entry.levelName === controller.currentLevelName);
  button.classList.toggle("previewed", entry.levelName === controller.previewLevelName);
  button.dataset.levelName = entry.levelName;
  button.innerHTML = `
    <span class="level-ref">${entry.referenceNameWithOldLetter}</span>
    <strong>${formatPuzzleTitle(controller, entry)}</strong>
    <span class="level-meta">${record ? `最优 ${record.bestMoveCount} 步` : "暂无记录"}</span>
  `;
  button.addEventListener("mouseenter", () => {
    if (controller.previewLocked) {
      return;
    }
    controller.previewLevelName = entry.levelName;
    controller.previewLastAdvanceAt = performance.now();
    syncPreviewHighlight(controller, elements);
    renderPreview(controller, elements);
    renderGame(controller, elements);
  });
  button.addEventListener("click", () => {
    void loadLevel(controller, elements, entry.levelName);
  });
  return button;
}

/**
 * @param {any} controller
 * @param {any} elements
 * @param {any} entry
 * @returns {HTMLDivElement}
 */
function createCustomLevelCard(controller, elements, entry) {
  const record = getRecordForEntry(controller.records, entry);
  const hasMismatch = hasHashMismatchRecord(controller.records, entry.levelId, entry.levelHash);
  const card = document.createElement("div");
  card.className = "level-button custom-level-card";
  card.classList.toggle("active", entry.levelName === controller.currentLevelName);
  card.classList.toggle("previewed", entry.levelName === controller.previewLevelName);
  card.tabIndex = 0;
  card.dataset.levelName = entry.levelName;
  card.innerHTML = `
    <span class="level-ref">${entry.referenceNameWithOldLetter}</span>
    <strong title="${escapeHtml(entry.displayName)}">${escapeHtml(entry.displayName)}</strong>
    <span class="level-meta">${record ? `最优 ${record.bestMoveCount} 步` : hasMismatch ? "关卡已变更，旧回放不可用" : "暂无记录"}</span>
    <div class="custom-card-actions">
      ${record || hasMismatch ? `<button class="custom-delete-record record-delete" type="button" aria-label="删除 ${escapeHtml(entry.displayName)} 的记录">删记录</button>` : ""}
      <button class="custom-delete-level" type="button" aria-label="删除关卡 ${escapeHtml(entry.displayName)} 及记录">删关卡</button>
    </div>
  `;
  card.addEventListener("mouseenter", () => {
    if (controller.previewLocked) {
      return;
    }
    controller.previewLevelName = entry.levelName;
    controller.previewLastAdvanceAt = performance.now();
    syncPreviewHighlight(controller, elements);
    renderPreview(controller, elements);
    renderGame(controller, elements);
  });
  card.addEventListener("click", () => {
    void loadLevel(controller, elements, entry.levelName);
  });
  card.addEventListener("keydown", (event) => {
    if (event.target instanceof HTMLElement && event.target.closest("button")) {
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    void loadLevel(controller, elements, entry.levelName);
  });
  const deleteRecordButton = card.querySelector(".custom-delete-record");
  deleteRecordButton?.addEventListener("click", (event) => {
    event.stopPropagation();
    deleteLevelRecords(controller, elements, entry, elements.customStatus);
  });
  const deleteLevelButton = card.querySelector(".custom-delete-level");
  deleteLevelButton?.addEventListener("click", (event) => {
    event.stopPropagation();
    deleteCustomLevel(controller, elements, entry.levelId);
  });
  return card;
}

/**
 * @param {any} controller
 * @param {any} elements
 */
function syncPageJumpInput(controller, elements) {
  elements.pageJump.value = `${controller.currentPageIndex + 1}`;
}

/**
 * @param {any} controller
 * @param {any} elements
 */
function attemptPageJump(controller, elements) {
  const raw = elements.pageJump.value.trim();
  const pageNumber = Number.parseInt(raw, 10);
  if (!Number.isFinite(pageNumber) || pageNumber < 1 || pageNumber > controller.database.pages.length) {
    syncPageJumpInput(controller, elements);
    return;
  }
  setCurrentPage(controller, elements, pageNumber - 1);
}

/**
 * @param {any} controller
 * @param {any} elements
 */
function renderPreview(controller, elements) {
  const levelName = controller.previewLevelName;
  const entry = getEntry(controller, levelName);
  elements.previewCard.classList.toggle("no-image", !entry || Boolean(entry.custom));
  if (!levelName || !entry) {
    elements.previewTitle.textContent = "尚未选择关卡";
    elements.previewSubtitle.textContent = "等待预览轮播或点击关卡进入";
    setImageSrc(elements.previewImage, "");
    return;
  }

  elements.previewTitle.textContent = formatPuzzleTitle(controller, entry);
  if (entry.custom) {
    const mismatch = hasHashMismatchRecord(controller.records, entry.levelId, entry.levelHash);
    elements.previewSubtitle.textContent = `自定义关卡 · ${mismatch ? "内容已变更，旧回放不可用 · " : ""}hash ${entry.levelHash.slice(0, 12)}`;
    setImageSrc(elements.previewImage, "");
    return;
  }

  elements.previewSubtitle.textContent = `${controller.previewLocked ? "已锁定预览" : "自动预览中"} · 编号 ${entry.referenceNameWithOldLetter} · ${resolveAreaLabel(controller, entry.areaLocalizationId, entry.pageKey)}`;
  setImageSrc(elements.previewImage, _getThumbSrc(levelName));
  elements.previewImage.alt = entry.referenceNameWithOldLetter;
}

/**
 * @param {any} controller
 * @param {any} elements
 */
function renderGame(controller, elements) {
  const previewLevelName = controller.currentLevelName ?? controller.previewLevelName;
  renderOfficialPreview(controller, elements, previewLevelName);

  if (!controller.currentState) {
    const pendingEntry = getEntry(controller, controller.pendingLevelName);
    elements.levelTitle.textContent = pendingEntry ? `正在载入 · ${formatPuzzleTitle(controller, pendingEntry)}` : "选择一个关卡";
    elements.levelStatus.textContent = resolveEmptyStatus(controller);
    elements.replayPanel.hidden = true;
    elements.undo.disabled = true;
    elements.redo.disabled = true;
    elements.restart.disabled = true;
    elements.backToLive.hidden = true;
    return;
  }

  const state = controller.replay.active ? controller.replay.state : controller.currentState;
  const entry = getCurrentEntry(controller);
  const record = getCurrentRecord(controller);
  const mismatch = entry?.custom ? hasHashMismatchRecord(controller.records, entry.levelId, entry.levelHash) : false;
  elements.levelTitle.textContent = entry ? formatPuzzleTitle(controller, entry) : "当前关卡";

  const turns = state.undoStack || [];
  let startIndex = 0;
  for (let index = 0; index < turns.length; index += 1) {
    if (turns[index]?.command === "Restart" || turns[index]?.isRestart) {
      startIndex = index + 1;
    }
  }
  let macroMoves = 0;
  let lastGroup = undefined;
  for (let index = startIndex; index < turns.length; index += 1) {
    const turn = turns[index];
    if (turn.mpGroup !== undefined) {
      if (turn.mpGroup !== lastGroup) {
        macroMoves += 1;
      }
    } else {
      macroMoves += 1;
    }
    lastGroup = turn.mpGroup;
  }
  elements.levelStatus.textContent = `步数 ${macroMoves} · ${state.winning ? "已通关" : "进行中"}${record ? ` · 最优 ${record.bestMoveCount} 步` : mismatch ? " · 关卡内容已变更，旧回放不可用" : ""}`;
  elements.undo.disabled = controller.replay.active;
  elements.redo.disabled = controller.replay.active;
  elements.restart.disabled = controller.replay.active;
  elements.backToLive.hidden = !controller.replay.active;
  elements.replayPanel.hidden = !record;
  elements.replayDeleteRecord.hidden = !record;
  elements.replayDeleteRecord.disabled = !record;

  if (record) {
    elements.replayRange.max = `${record.inputLog.length}`;
    elements.replayRange.value = `${controller.replay.active ? controller.replay.step : 0}`;
    elements.replaySummary.textContent = `${record.bestMoveCount} 步 · ${record.inputCount} 次输入`;
    elements.replayPlay.textContent = controller.replay.playing ? "暂停" : "播放";
  }
}

/**
 * @param {any} controller
 * @param {any} elements
 * @param {string | null} levelName
 */
function renderOfficialPreview(controller, elements, levelName) {
  const entry = getEntry(controller, levelName);
  if (!entry || entry.custom) {
    elements.officialPreview.hidden = true;
    setImageSrc(elements.officialPreviewImage, "");
    return;
  }

  const thumbSrc = _getThumbSrc(entry.levelName);
  elements.officialPreview.hidden = !thumbSrc;
  elements.officialPreviewLabel.textContent = `${controller.currentLevelName ? "官方预览" : "轮播预览"} · ${entry.referenceNameWithOldLetter}`;
  setImageSrc(elements.officialPreviewImage, thumbSrc);
  elements.officialPreviewImage.alt = entry.referenceNameWithOldLetter;
}

/**
 * @param {any} controller
 * @param {any} elements
 */
function renderCanvas(controller, elements) {
  const state = controller.replay.active ? controller.replay.state : controller.currentState;
  const infoText = resolveInfoText(controller, state);
  const emptyText = resolveCanvasEmptyText(controller);
  const animation =
    controller.replay.active || !controller.animation
      ? null
      : {
          turn: controller.animation.turn,
          direction: controller.animation.direction,
          progress: Math.min(1, (performance.now() - controller.animation.startedAt) / controller.animation.duration)
        };
  controller.renderer.render(state, { animation, infoText, emptyText });
  renderGame(controller, elements);
}

/**
 * @param {any} controller
 * @param {any} state
 * @returns {string | null}
 */
function resolveInfoText(controller, state) {
  if (!state?.playerBlocks?.[0]) {
    return null;
  }
  const player = state.playerBlocks[0];
  const floor = player.outerLevel?.floors?.[player.ypos]?.[player.xpos];
  if (!floor || floor.type !== "Info") {
    return null;
  }
  if (!floor.localizeInfo) {
    return floor.info;
  }
  return localize(controller.database.localization, state.prefs.language, floor.info);
}

/**
 * @param {any} controller
 * @param {string | null | undefined} areaLocalizationId
 * @param {string | null | undefined} fallbackKey
 * @returns {string}
 */
function resolveAreaLabel(controller, areaLocalizationId, fallbackKey) {
  if (fallbackKey === "custom") {
    return "自定义关卡";
  }
  if (areaLocalizationId) {
    return localize(controller.database.localization, controller.language, areaLocalizationId);
  }
  return fallbackKey ?? "未分类";
}

/**
 * @param {any} controller
 * @param {any} entry
 * @returns {string}
 */
function formatPuzzleTitle(controller, entry) {
  if (entry?.custom) {
    return entry.displayName;
  }
  const areaLabel = resolveAreaLabel(controller, entry.areaLocalizationId, entry.pageKey);
  if (Number.isFinite(entry.referenceIndex)) {
    return `${areaLabel} · 第 ${entry.referenceIndex} 题`;
  }
  return `${areaLabel} · ${entry.referenceNameWithOldLetter}`;
}

/**
 * @param {any} controller
 * @returns {string}
 */
function resolveCanvasEmptyText(controller) {
  if (controller.loadErrorMessage) {
    return "关卡载入失败";
  }
  if (controller.pendingLevelName) {
    const entry = getEntry(controller, controller.pendingLevelName);
    return entry ? `正在载入 ${entry.referenceNameWithOldLetter}` : "正在载入关卡";
  }
  return "点击左侧关卡开始";
}

/**
 * @param {any} controller
 */
function unlockPreview(controller) {
  controller.previewLocked = false;
  controller.previewLastAdvanceAt = performance.now();
}

/**
 * @param {any} controller
 * @param {any} elements
 */
function syncPreviewHighlight(controller, elements) {
  for (const element of elements.levelGrid.querySelectorAll(".level-button")) {
    const levelName = element.dataset.levelName ?? "";
    element.classList.toggle("previewed", levelName === controller.previewLevelName);
    element.classList.toggle("active", levelName === controller.currentLevelName);
  }
}

/**
 * @param {any} controller
 * @param {any} elements
 */
function maybeAdvancePreview(controller, elements) {
  if (controller.previewLocked) {
    return;
  }
  const page = controller.database.pages[controller.currentPageIndex];
  if (!page || page.custom || page.entries.length <= 1) {
    return;
  }
  const now = performance.now();
  if (now - controller.previewLastAdvanceAt < PREVIEW_CYCLE_MS) {
    return;
  }

  const currentIndex = Math.max(
    0,
    page.entries.findIndex((entry) => entry.levelName === controller.previewLevelName)
  );
  const nextIndex = (currentIndex + 1) % page.entries.length;
  controller.previewLevelName = page.entries[nextIndex].levelName;
  controller.previewLastAdvanceAt = now;
  syncPreviewHighlight(controller, elements);
  renderPreview(controller, elements);
  if (!controller.currentState) {
    renderGame(controller, elements);
  }
}

/**
 * @param {any} controller
 * @returns {string}
 */
function resolveEmptyStatus(controller) {
  if (controller.loadErrorMessage) {
    return `关卡载入失败：${controller.loadErrorMessage}`;
  }
  if (controller.pendingLevelName) {
    const entry = getEntry(controller, controller.pendingLevelName);
    return entry ? `正在准备规则与渲染：${formatPuzzleTitle(controller, entry)}` : "正在准备规则与渲染";
  }
  return controller.previewLocked ? "预览已锁定，点击外部区域恢复轮播" : "尚未载入关卡，左侧预览会自动轮播";
}

/**
 * @param {any} controller
 * @param {string | null | undefined} levelName
 * @returns {any | null}
 */
function getEntry(controller, levelName) {
  return controller.database.puzzleData.get(levelName ?? "") ?? null;
}

/**
 * @param {any} controller
 * @returns {any | null}
 */
function getCurrentEntry(controller) {
  return getEntry(controller, controller.currentLevelName);
}

/**
 * @param {Map<string, any>} records
 * @param {any | null} entry
 * @returns {any | null}
 */
function getRecordForEntry(records, entry) {
  if (!entry) {
    return null;
  }
  return getRecord(records, entry.levelId ?? entry.levelName, entry.levelHash ?? null);
}

/**
 * @param {any} controller
 * @returns {any | null}
 */
function getCurrentRecord(controller) {
  return getRecordForEntry(controller.records, getCurrentEntry(controller));
}

/**
 * @param {any} controller
 * @param {any} elements
 * @param {any} entry
 * @param {HTMLElement | null} [statusElement]
 */
function deleteLevelRecords(controller, elements, entry, statusElement = null) {
  const levelId = entry?.levelId ?? entry?.levelName;
  if (!levelId) {
    return;
  }
  const record = getRecordForEntry(controller.records, entry);
  const hasMismatch = entry.custom ? hasHashMismatchRecord(controller.records, levelId, entry.levelHash) : false;
  if (!record && !hasMismatch) {
    return;
  }
  if (!globalThis.confirm(`删除「${formatPuzzleTitle(controller, entry)}」的所有记录？`)) {
    return;
  }
  controller.records = deleteRecordsForLevel(controller.records, levelId);
  saveRecords(globalThis.localStorage, controller.records);
  updateSolvedCount(controller);
  if (controller.currentLevelName === entry.levelName || controller.currentLevelName === levelId) {
    controller.replay.active = false;
    controller.replay.state = null;
    controller.replay.step = 0;
    controller.replay.playing = false;
  }
  if (statusElement) {
    statusElement.textContent = `已删除记录：${formatPuzzleTitle(controller, entry)}`;
  }
  renderSelector(controller, elements);
  renderGame(controller, elements);
}

/**
 * @param {any} controller
 */
function updateSolvedCount(controller) {
  controller.solvedCount = controller.database.puzzleEntries.filter((entry) => getRecordForEntry(controller.records, entry)).length;
}

/**
 * @param {any} controller
 * @param {any} elements
 */
async function importCustomLevelFiles(controller, elements) {
  const files = [...(elements.customImportFile.files ?? [])];
  elements.customImportFile.value = "";
  if (files.length === 0) {
    return;
  }

  const imported = [];
  const errors = [];
  for (const file of files) {
    if (/\.zip$/i.test(file.name)) {
      try {
        const zipLevels = await extractLevelTextsFromZipFile(file);
        for (const level of zipLevels) {
          imported.push(await createCustomLevel(level));
        }
        if (zipLevels.length === 0) {
          errors.push(`${file.name}: no Parafox txt/bytes levels found`);
        }
      } catch (error) {
        errors.push(`${file.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
      continue;
    }
    const text = await file.text();
    const trimmed = text.trim();
    if ((/\.json$/i.test(file.name) || trimmed.startsWith("{") || trimmed.startsWith("[")) && !isParafoxLevelText(text)) {
      const result = await importCustomLevelPack(text);
      imported.push(...result.levels);
      errors.push(...result.errors.map((error) => `${file.name}: ${error}`));
      continue;
    }
    try {
      imported.push(await createCustomLevel({
        name: nameFromFileName(file.name),
        text
      }));
    } catch (error) {
      errors.push(`${file.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (imported.length === 0) {
    elements.customStatus.textContent = `导入失败：${errors.join("; ")}`;
    return;
  }

  const result = mergeCustomLevels(controller.customLevels, imported);
  controller.customLevels = result.levels;
  saveCustomLevels(globalThis.localStorage, controller.customLevels);
  applyCustomLevelsToDatabase(controller.database, controller.customLevels);
  updateSolvedCount(controller);
  const firstCustomPage = controller.database.pages.findIndex((page) => page.custom);
  if (firstCustomPage >= 0) {
    controller.currentPageIndex = firstCustomPage;
    controller.previewLevelName = controller.database.pages[firstCustomPage].entries[0]?.levelName ?? null;
    unlockPreview(controller);
  }
  elements.customStatus.textContent = `导入完成：新增 ${result.added} · 更新 ${result.updated}${errors.length ? ` · 跳过 ${errors.length}` : ""}`;
  renderSelector(controller, elements);
  renderGame(controller, elements);
}

/**
 * @param {any} controller
 * @param {any} elements
 * @param {string} levelId
 */
function deleteCustomLevel(controller, elements, levelId) {
  const entry = getEntry(controller, levelId);
  if (!entry?.custom) {
    return;
  }
  if (!globalThis.confirm(`删除自定义关卡「${entry.displayName}」以及它的所有记录？`)) {
    return;
  }
  const result = removeCustomLevel(controller.customLevels, levelId);
  if (!result.removed) {
    return;
  }
  controller.customLevels = result.levels;
  controller.records = deleteRecordsForLevel(controller.records, levelId);
  saveCustomLevels(globalThis.localStorage, controller.customLevels);
  saveRecords(globalThis.localStorage, controller.records);
  applyCustomLevelsToDatabase(controller.database, controller.customLevels);
  updateSolvedCount(controller);
  if (controller.currentLevelName === levelId) {
    controller.currentState = null;
    controller.currentLevelName = null;
    controller.currentLevelText = "";
    controller.replay.active = false;
    controller.replay.state = null;
    controller.replay.playing = false;
  }
  if (controller.currentPageIndex >= controller.database.pages.length) {
    controller.currentPageIndex = Math.max(0, controller.database.pages.length - 1);
  }
  controller.previewLevelName = controller.database.pages[controller.currentPageIndex]?.entries[0]?.levelName ?? null;
  elements.customStatus.textContent = "已删除自定义关卡";
  renderSelector(controller, elements);
  renderGame(controller, elements);
}

/**
 * @param {string} text
 * @param {string} fileName
 * @param {string} type
 */
function downloadText(text, fileName, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function createLayout() {
  return `
    <main class="app-shell">
      <section class="panel selector-panel">
        <div class="panel-header">
          <h1>Patrick's Parabox</h1>
          <div class="page-controls">
            <button id="prev-page" type="button">上一页</button>
            <span id="page-label"></span>
            <button id="next-page" type="button">下一页</button>
            <div class="page-jump-group">
              <input id="page-jump" type="number" min="1" step="1" inputmode="numeric" aria-label="跳转页码" />
              <button id="page-jump-button" type="button">跳转</button>
            </div>
          </div>
        </div>
        <p id="selector-summary" class="selector-summary"></p>
        <div class="preview-card">
          <img id="preview-image" alt="" />
          <div class="preview-copy">
            <strong id="preview-title"></strong>
            <span id="preview-subtitle"></span>
          </div>
        </div>
        <div id="level-grid" class="level-grid"></div>
        <div class="custom-level-tools">
          <strong>自定义关卡</strong>
          <div class="custom-level-actions">
            <button id="custom-import" type="button">导入关卡/包</button>
            <button id="custom-export" type="button">导出关卡包</button>
            <input id="custom-import-file" type="file" accept=".txt,.bytes,.json,.zip" multiple hidden />
          </div>
          <span id="custom-status" class="custom-status"></span>
        </div>
      </section>
      <section class="panel game-panel">
        <div class="panel-header panel-header-game">
          <div>
            <h2 id="level-title">Loading...</h2>
            <p id="level-status"></p>
            <p id="command-hint" class="command-hint">方向键 / WASD 移动 · Z 撤销 · Y 重做 · R 重开</p>
          </div>
          <div class="game-controls">
            <button id="undo" type="button">撤销</button>
            <button id="redo" type="button">重做</button>
            <button id="restart" type="button">重开</button>
            <button id="back-to-live" type="button" hidden>返回实时状态</button>
          </div>
        </div>
        <div class="canvas-wrap">
          <div id="official-preview" class="official-preview" hidden>
            <span id="official-preview-label" class="official-preview-label">官方预览</span>
            <img id="official-preview-image" alt="" />
          </div>
          <canvas id="game-canvas"></canvas>
        </div>
        <div id="replay-panel" class="replay-panel" hidden>
          <div class="replay-header">
            <strong>最佳回放</strong>
            <span id="replay-summary"></span>
          </div>
          <div class="replay-controls">
            <button id="replay-play" type="button">播放</button>
            <button id="replay-step" type="button">单步</button>
            <button id="replay-reset" type="button">归零</button>
            <button id="replay-delete-record" class="record-delete" type="button">删除记录</button>
            <label>
              速度
              <select id="replay-speed">
                <option value="0.5">0.5x</option>
                <option value="1" selected>1x</option>
                <option value="2">2x</option>
                <option value="4">4x</option>
              </select>
            </label>
          </div>
          <input id="replay-range" type="range" min="0" max="0" value="0" />
        </div>
        <div id="save-panel" class="save-load-panel">
          <button id="save-export" type="button">导出记录</button>
          <button id="save-import" type="button">导入记录</button>
          <input id="save-import-file" type="file" accept=".json" hidden />
          <span id="save-status" class="save-status"></span>
        </div>
      </section>
    </main>
  `;
}

/**
 * @param {HTMLElement} app
 */
function getElements(app) {
  return {
    prevPage: /** @type {HTMLButtonElement} */ (app.querySelector("#prev-page")),
    nextPage: /** @type {HTMLButtonElement} */ (app.querySelector("#next-page")),
    pageJump: /** @type {HTMLInputElement} */ (app.querySelector("#page-jump")),
    pageJumpButton: /** @type {HTMLButtonElement} */ (app.querySelector("#page-jump-button")),
    pageLabel: /** @type {HTMLSpanElement} */ (app.querySelector("#page-label")),
    selectorSummary: /** @type {HTMLParagraphElement} */ (app.querySelector("#selector-summary")),
    previewImage: /** @type {HTMLImageElement} */ (app.querySelector("#preview-image")),
    previewTitle: /** @type {HTMLSpanElement} */ (app.querySelector("#preview-title")),
    previewSubtitle: /** @type {HTMLSpanElement} */ (app.querySelector("#preview-subtitle")),
    previewCard: /** @type {HTMLDivElement} */ (app.querySelector(".preview-card")),
    levelGrid: /** @type {HTMLDivElement} */ (app.querySelector("#level-grid")),
    customImport: /** @type {HTMLButtonElement} */ (app.querySelector("#custom-import")),
    customExport: /** @type {HTMLButtonElement} */ (app.querySelector("#custom-export")),
    customImportFile: /** @type {HTMLInputElement} */ (app.querySelector("#custom-import-file")),
    customStatus: /** @type {HTMLSpanElement} */ (app.querySelector("#custom-status")),
    levelTitle: /** @type {HTMLHeadingElement} */ (app.querySelector("#level-title")),
    levelStatus: /** @type {HTMLParagraphElement} */ (app.querySelector("#level-status")),
    undo: /** @type {HTMLButtonElement} */ (app.querySelector("#undo")),
    redo: /** @type {HTMLButtonElement} */ (app.querySelector("#redo")),
    restart: /** @type {HTMLButtonElement} */ (app.querySelector("#restart")),
    backToLive: /** @type {HTMLButtonElement} */ (app.querySelector("#back-to-live")),
    officialPreview: /** @type {HTMLDivElement} */ (app.querySelector("#official-preview")),
    officialPreviewLabel: /** @type {HTMLSpanElement} */ (app.querySelector("#official-preview-label")),
    officialPreviewImage: /** @type {HTMLImageElement} */ (app.querySelector("#official-preview-image")),
    canvas: /** @type {HTMLCanvasElement} */ (app.querySelector("#game-canvas")),
    replayPanel: /** @type {HTMLDivElement} */ (app.querySelector("#replay-panel")),
    replayPlay: /** @type {HTMLButtonElement} */ (app.querySelector("#replay-play")),
    replayStep: /** @type {HTMLButtonElement} */ (app.querySelector("#replay-step")),
    replayReset: /** @type {HTMLButtonElement} */ (app.querySelector("#replay-reset")),
    replayDeleteRecord: /** @type {HTMLButtonElement} */ (app.querySelector("#replay-delete-record")),
    replayRange: /** @type {HTMLInputElement} */ (app.querySelector("#replay-range")),
    replaySpeed: /** @type {HTMLSelectElement} */ (app.querySelector("#replay-speed")),
    replaySummary: /** @type {HTMLSpanElement} */ (app.querySelector("#replay-summary")),
    saveExport: /** @type {HTMLButtonElement} */ (app.querySelector("#save-export")),
    saveImport: /** @type {HTMLButtonElement} */ (app.querySelector("#save-import")),
    saveImportFile: /** @type {HTMLInputElement} */ (app.querySelector("#save-import-file")),
    saveStatus: /** @type {HTMLSpanElement} */ (app.querySelector("#save-status"))
  };
}

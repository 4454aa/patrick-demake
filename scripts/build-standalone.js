// Build index-standalone.html — single-file self-contained game.
// Usage: node scripts/build-standalone.js
const { readFileSync, writeFileSync } = require("fs");
const { resolve, dirname } = require("path");
const ROOT = dirname(__dirname);

function b64(file) {
  const buf = readFileSync(resolve(ROOT, file));
  return "data:" + (/\.png$/i.test(file) ? "image/png" : "font/ttf") + ";base64," + buf.toString("base64");
}
function txt(file) { return readFileSync(resolve(ROOT, file), "utf-8"); }

// ---- Embedded data ----
const SHEET_TEX = b64("game-data/textures-sheet.png");
const SHEET_THUMB = b64("game-data/level_thumbnails-sheet.png");
const FONT_JOST = b64("game-data/fonts/Jost-SemiBold.ttf");
const FONT_INCONSOLATA = b64("game-data/fonts/Inconsolata-SemiBold.ttf");
const ICO = b64("1.ico");

const dataVars = [
  `var _E={};`,
  `_E["/game-data/levels-bundle.json"]=${JSON.stringify(txt("game-data/levels-bundle.json"))};`,
  `_E["/game-data/puzzle_data.bytes"]=${JSON.stringify(txt("game-data/puzzle_data.bytes"))};`,
  `_E["/game-data/puzzle_lines.bytes"]=${JSON.stringify(txt("game-data/puzzle_lines.bytes"))};`,
  `_E["/game-data/palettes.bytes"]=${JSON.stringify(txt("game-data/palettes.bytes"))};`,
  `_E["/game-data/localization.bytes"]=${JSON.stringify(txt("game-data/localization.bytes"))};`,
  `_E["/game-data/textures-manifest.json"]=${JSON.stringify(txt("game-data/textures-manifest.json"))};`,
  `_E["/game-data/level_thumbnails-manifest.json"]=${JSON.stringify(txt("game-data/level_thumbnails-manifest.json"))};`,
  `_E["/game-data/wall_big_data.bytes"]=${JSON.stringify(txt("game-data/wall_big_data.bytes"))};`,
].join("\n");

// ---- Minimal fetch override (no Image override needed) ----
const fetchOverride = `
${dataVars}
var _TM=JSON.parse(_E["/game-data/textures-manifest.json"]);
var _THM=JSON.parse(_E["/game-data/level_thumbnails-manifest.json"]);
var _origFetch=window.fetch;
window.fetch=function(u){
  var k=typeof u==="string"?u:(u.url||"").replace(/file:\\/\\/[^\\/]+/,"").replace(/https?:\\/\\/[^\\/]+/,"").split("?")[0];
  var d=_E[k]||_E[k.replace(/^\\.\\/game-data/,"/game-data/")];
  if(d!==undefined)return Promise.resolve({ok:true,status:200,text:function(){return Promise.resolve(d)},json:function(){return Promise.resolve(JSON.parse(d))}});
  return _origFetch? _origFetch(u):Promise.reject(new Error("not embedded:"+k));
};
`.replace(/\n\s*/g, "\n").trim();

// ---- JS bundle ----
const ORDER = [
  "src/parser/invariant.js", "src/core/model.js", "src/core/engine.js",
  "src/core/script-runner.js", "src/parser/localization.js", "src/parser/resources.js",
  "src/parser/level.js", "src/render/canvas-renderer.js", "src/runtime/custom-levels.js",
  "src/runtime/records.js", "src/runtime/controller.js", "src/app/main.js"
];

let bundle = fetchOverride + "\n";
for (const f of ORDER) {
  let s = txt(f);
  // Strip import/export
  s = s.replace(/^import\s*\{[^}]*\}\s*from\s*["'][^"']+["'];?\s*$/gm, "");
  s = s.replace(/^import\s+["'][^"']+["'];?\s*$/gm, "");
  s = s.replace(/^import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\s*$/gm, "");
  s = s.replace(/^export\s+(default\s+)?/gm, "");
  s = s.replace(/^export\s*\{[^}]+\};?\s*$/gm, "");
  // Replace texture sheet URL with embedded base64
  s = s.replace(/"\/game-data\/textures-sheet\.png"/g, JSON.stringify(SHEET_TEX));
  s = s.replace(/"\/game-data\/level_thumbnails-sheet\.png"/g, JSON.stringify(SHEET_THUMB));
  bundle += s + "\n";
}

// ---- CSS ----
let css = txt("src/app/styles.css");
css = css.replace(/url\("\/game-data\/fonts\/Jost-SemiBold\.ttf"\)/, 'url(' + JSON.stringify(FONT_JOST) + ')');
css = css.replace(/url\("\/game-data\/fonts\/Inconsolata-SemiBold\.ttf"\)/, 'url(' + JSON.stringify(FONT_INCONSOLATA) + ')');

// ---- HTML ----
let html = txt("index.html");
html = html.replace(/<link rel="stylesheet".+/, "<style>\n" + css + "\n</style>");
html = html.replace(/<script type="module".+/, "<script>\n" + bundle + "\n</script>");
html = html.replace('href="1.ico"', 'href="' + ICO + '"');

writeFileSync(resolve(ROOT, "index-standalone.html"), html);
console.log("index-standalone.html: " + (html.length / 1024).toFixed(0) + " KB");

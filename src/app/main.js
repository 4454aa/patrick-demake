import { boot } from "../runtime/controller.js";

const app = /** @type {HTMLElement | null} */ (document.querySelector("#app"));

if (!app) {
  throw new Error("Missing #app root");
}

void boot(app);

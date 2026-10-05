// HashRammers: the Herder's page. Its panel, and nothing else.

import { RAMherdAPI, updateDemoNote } from "./mock-data.js";
import { initNav } from "./nav.js";
import { mountHerderPanel } from "./herder-panel.js";

initNav();
updateDemoNote("The Herder's summary and its answers are real, grounded in the live server's own state.");

const panel = mountHerderPanel();
// Same rule as herd.js: a failed first fetch must not reject the module's top-level
// await, or the poll below never starts and the page stays empty until a reload.
try {
  await Promise.all([panel.render(), panel.seedChat()]);
} catch (err) {
  console.error("First render failed; the live poll will retry.", err);
}
RAMherdAPI.subscribeLive(() => panel.render(), 4000);

// RAMherd: the Herder's page. Its panel, and nothing else.

import { RAMherdAPI } from "./mock-data.js";
import { initNav } from "./nav.js";
import { mountHerderPanel } from "./herder-panel.js";

initNav();

const panel = mountHerderPanel();
await Promise.all([panel.render(), panel.seedChat()]);
RAMherdAPI.subscribeLive(() => panel.render(), 4000);

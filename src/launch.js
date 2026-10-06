// HashRammers entry slip ("Create a RAM", /launch). Data comes through RAMherdAPI.launchpad
// (mock-data.js auto-detects the real backend; see `backendReady` there); rules come from
// launchpad-rules.js.
//
// Signing is gated twice: LAUNCHPAD_LIVE below AND `config.live` from the API must both be
// true. Today LAUNCHPAD_LIVE is false, so the signing button is never enabled and
// signAndSendLaunch() throws before doing anything.

import { RAMherdAPI, backendReady } from "./mock-data.js";
import { initNav } from "./nav.js";
import {
  HASH_FAMILIES,
  APPROACHES,
  MODELS,
  LIMITS,
  CREATE_FEE_SOL,
  TREASURY,
  LAUNCHPAD_LIVE,
  isLaunchpadLive,
  familyByName,
  validateDraft,
  validateImage,
  IMAGE_LIMITS,
  normalizeSymbol,
  toRamRequest,
} from "./launchpad-rules.js";

export { LAUNCHPAD_LIVE };

const api = RAMherdAPI.launchpad;
const $ = (id) => document.getElementById(id);
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

const state = {
  config: null, // the launchpad block from GET /api/launchpad/config
  configIsMock: true,
  provider: null, // Phantom's injected provider
  owner: null, // base58 address once connected
  checking: false,
  ramId: null, // the RAM recorded by the last successful check
  imageFile: null, // the File picked for the token image
  uploaded: null, // { file, id } once that exact File was uploaded, so a re-check doesn't upload it again
};

export function isLive() {
  return isLaunchpadLive(state.config);
}

// ---------------------------------------------------------------------------
// The one motion: a changed value is re-inked left to right (same as the board).
// ---------------------------------------------------------------------------

function ink(el) {
  if (reducedMotion.matches) return;
  el.classList.remove("writing");
  void el.offsetWidth;
  el.classList.add("writing");
}
document.addEventListener("animationend", (e) => {
  if (e.target.classList && e.target.classList.contains("writing")) e.target.classList.remove("writing");
});

function write(el, text, { animate = true } = {}) {
  if (el.textContent === text) return false;
  el.textContent = text;
  if (animate) ink(el);
  return true;
}

const shortAddress = (a) => (a && a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a || "");

// The top bar is the same on every page; its toggle lives in nav.js.
initNav();

// ---------------------------------------------------------------------------
// Part 1: Phantom. Connecting only reads the public key; nothing is signed here.
// ---------------------------------------------------------------------------

function findPhantom() {
  const p = window.phantom?.solana;
  if (p?.isPhantom) return p;
  if (window.solana?.isPhantom) return window.solana;
  return null;
}

function showWallet(which) {
  for (const id of ["wallet-checking", "wallet-missing", "wallet-disconnected", "wallet-connected"]) {
    $(id).hidden = id !== which;
  }
}

function setOwner(address) {
  state.owner = address || null;
  if (state.owner) {
    $("wallet-address").textContent = shortAddress(state.owner);
    $("wallet-address").title = state.owner;
    showWallet("wallet-connected");
  } else {
    showWallet(state.provider ? "wallet-disconnected" : "wallet-missing");
  }
  clearError("owner");
  refresh();
}

async function connectWallet() {
  if (!state.provider) return;
  const btn = $("connect-btn");
  btn.disabled = true;
  btn.textContent = "Connecting…";
  try {
    const resp = await state.provider.connect();
    setOwner((resp?.publicKey ?? state.provider.publicKey)?.toString());
  } catch (err) {
    // 4001 = the visitor closed or rejected the Phantom prompt.
    showError("owner", err?.code === 4001 ? "Phantom did not connect: the request was closed." : "Phantom could not connect. Try again.");
  } finally {
    btn.disabled = false;
    btn.textContent = "Connect Phantom";
  }
}

async function disconnectWallet() {
  try {
    await state.provider?.disconnect();
  } catch {
    /* the provider forgets the site either way */
  }
  setOwner(null);
}

function initWallet() {
  state.provider = findPhantom();
  if (!state.provider) {
    showWallet("wallet-missing");
    return;
  }
  showWallet("wallet-disconnected");
  state.provider.on?.("disconnect", () => setOwner(null));
  state.provider.on?.("accountChanged", (pk) => setOwner(pk ? pk.toString() : null));
  // Reconnect silently only if this site was already trusted; never prompts.
  state.provider
    .connect({ onlyIfTrusted: true })
    .then((resp) => resp?.publicKey && setOwner(resp.publicKey.toString()))
    .catch(() => {});
}

$("connect-btn").addEventListener("click", connectWallet);
$("disconnect-btn").addEventListener("click", disconnectWallet);

// ---------------------------------------------------------------------------
// Parts 2 to 4: choices, built from the config (the server's, or the fallback's)
// ---------------------------------------------------------------------------

function choice({ name, value, main, sub, checked = false }) {
  const label = document.createElement("label");
  label.className = "choice";
  const input = document.createElement("input");
  input.type = "radio";
  input.name = name;
  input.value = value;
  input.checked = checked;
  const ring = document.createElement("span");
  ring.className = "ring";
  ring.setAttribute("aria-hidden", "true");
  const text = document.createElement("span");
  text.className = "choice-text";
  const m = document.createElement("span");
  m.className = "choice-main";
  m.textContent = main;
  text.append(m);
  if (sub) {
    const s = document.createElement("span");
    s.className = "choice-sub";
    s.textContent = sub;
    text.append(s);
  }
  label.append(input, ring, text);
  return label;
}

function list(options, { twoCol = false } = {}) {
  const div = document.createElement("div");
  div.className = twoCol ? "choice-list two-col" : "choice-list";
  div.append(...options.map(choice));
  return div;
}

const families = () => state.config?.hashFamilies ?? HASH_FAMILIES;
const roundsText = (f) => `rounds ${f.tracks.map((t) => t.rounds).join(" and ")}, exploratory lane`;

function renderChoices() {
  $("family-options").replaceChildren(
    list(families().map((f) => ({ name: "hashFamily", value: f.family, main: f.family, sub: roundsText(f) })), { twoCol: false }),
  );
  const approaches = state.config?.approaches ?? APPROACHES;
  $("approach-options").replaceChildren(
    list(approaches.map((a) => ({ name: "approach", value: a.id, main: a.label, sub: a.id }))),
  );
  const models = state.config?.models ?? MODELS.map((slug, i) => ({ slug, ram: i + 1 }));
  $("model-options").replaceChildren(
    list(
      models.map((m) => ({ name: "model", value: m.slug, main: m.slug, sub: m.track ? `RAM ${m.ram}'s model, on ${m.track}` : `RAM ${m.ram}'s model` })),
      { twoCol: true },
    ),
  );
  renderTracks();
}

function renderTracks() {
  const family = families().find((f) => f.family === radioValue("hashFamily"));
  const box = $("track-options");
  if (!family) {
    box.replaceChildren();
    $("track-hint").textContent = "Choose a family first. Its first round is used unless you pick the other.";
    return;
  }
  const current = radioValue("track");
  const keep = family.tracks.some((t) => t.track === current) ? current : family.tracks[0].track;
  box.replaceChildren(
    list(
      family.tracks.map((t, i) => ({
        name: "track",
        value: t.track,
        main: `${family.family} r${t.rounds}`,
        sub: `${t.track}${i === 0 ? ", used if you do not choose" : ""}`,
        checked: t.track === keep,
      })),
      { twoCol: true },
    ),
  );
  $("track-hint").textContent = `${family.family} has ${family.tracks.length} rounds open. Your RAM works one of them.`;
}

function radioValue(name) {
  return document.querySelector(`input[name="${name}"]:checked`)?.value ?? "";
}

// ---------------------------------------------------------------------------
// Draft, errors, summary, slip index
// ---------------------------------------------------------------------------

function readDraft() {
  return {
    owner: state.owner ?? "",
    hashFamily: radioValue("hashFamily"),
    track: radioValue("track"),
    approach: radioValue("approach"),
    approachDetail: $("approach-detail").value,
    model: radioValue("model"),
    tokenName: $("token-name").value,
    tokenSymbol: $("token-symbol").value,
    image: state.imageFile,
  };
}

// ---------------------------------------------------------------------------
// The token image: checked and previewed here, uploaded when the entry is checked
// ---------------------------------------------------------------------------

function clearImagePreview() {
  const img = $("image-preview");
  img.hidden = true;
  img.removeAttribute("src");
  $("image-name").hidden = true;
  $("image-name").textContent = "";
}

function onImagePicked() {
  const file = $("token-image").files?.[0] ?? null;
  state.imageFile = null;
  clearImagePreview();
  if (!file) return;
  const check = validateImage(file);
  if (!check.ok) {
    showError("image", check.errors.image);
    $("token-image").value = "";
    return;
  }
  state.imageFile = file;
  $("image-name").textContent = `${file.name}, ${Math.max(1, Math.round(file.size / 1024))} KB`;
  $("image-name").hidden = false;
  // A data: URL, not a blob: one: the page CSP allows img-src 'self' data: only.
  const reader = new FileReader();
  reader.onload = () => {
    if (state.imageFile !== file) return; // a newer pick won
    const img = $("image-preview");
    img.src = String(reader.result);
    img.alt = `Preview of ${file.name}`;
    img.onerror = () => {
      // The browser could not decode it: not a real image, whatever its name says.
      if (state.imageFile !== file) return;
      state.imageFile = null;
      clearImagePreview();
      $("token-image").value = "";
      showError("image", "That file could not be read as an image.");
      refresh();
    };
    img.hidden = false;
  };
  reader.readAsDataURL(file);
}

/** Uploads the picked image once; returns its id, or null after showing the error. */
async function ensureImageUploaded() {
  const file = state.imageFile;
  if (state.uploaded?.file === file) return state.uploaded.id;
  const up = await api.uploadImage(file);
  if (up.status !== 201 || !up.body?.ok || !up.body.image?.id) {
    showErrors({ image: up.body?.fields?.image || up.body?.message || `The image could not be uploaded (${up.body?.error || up.status}).` });
    return null;
  }
  state.uploaded = { file, id: up.body.image.id };
  return state.uploaded.id;
}

const FIELD_CONTROL = {
  approachDetail: "approach-detail",
  tokenName: "token-name",
  tokenSymbol: "token-symbol",
  image: "token-image",
};
const FIELD_FOCUS = {
  owner: () => ($("wallet-disconnected").hidden ? $("h-wallet") : $("connect-btn")),
  hashFamily: () => document.querySelector('input[name="hashFamily"]'),
  track: () => document.querySelector('input[name="track"]'),
  approach: () => document.querySelector('input[name="approach"]'),
  model: () => document.querySelector('input[name="model"]'),
};

function showError(field, message) {
  const el = $(`err-${field}`);
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
  const ctl = FIELD_CONTROL[field] && $(FIELD_CONTROL[field]);
  if (ctl) ctl.setAttribute("aria-invalid", "true");
}

function clearError(field) {
  const el = $(`err-${field}`);
  if (el) {
    el.hidden = true;
    el.textContent = "";
  }
  const ctl = FIELD_CONTROL[field] && $(FIELD_CONTROL[field]);
  if (ctl) ctl.removeAttribute("aria-invalid");
}

const ALL_FIELDS = ["owner", "hashFamily", "track", "approach", "approachDetail", "model", "tokenName", "tokenSymbol", "image"];
const FIELD_ORDER = ALL_FIELDS;

function showErrors(errors) {
  for (const f of ALL_FIELDS) clearError(f);
  for (const [field, message] of Object.entries(errors)) showError(field, message);
  const first = FIELD_ORDER.find((f) => errors[f]);
  if (!first) return;
  const target = FIELD_CONTROL[first] ? $(FIELD_CONTROL[first]) : FIELD_FOCUS[first]?.();
  if (target) {
    if (!target.hasAttribute("tabindex") && target.tagName === "H2") target.setAttribute("tabindex", "-1");
    target.focus({ preventScroll: false });
  }
}

const approachLabel = (id) => (state.config?.approaches ?? APPROACHES).find((a) => a.id === id)?.label;

function setSum(key, text, empty) {
  const dd = document.querySelector(`[data-sum="${key}"]`);
  const value = text || empty;
  dd.classList.toggle("is-empty", !text);
  write(dd, value, { animate: Boolean(text) });
}

function setIndex(key, text, done) {
  const dd = document.querySelector(`[data-index="${key}"]`);
  dd.classList.toggle("is-done", done);
  write(dd, text, { animate: done });
}

function refresh() {
  const d = readDraft();
  const family = familyByName(d.hashFamily);
  const track = d.track || family?.tracks[0].track || "";
  const trackRec = family?.tracks.find((t) => t.track === track);
  const symbol = normalizeSymbol(d.tokenSymbol);

  setSum("owner", state.owner, "not connected");
  setSum("hashFamily", d.hashFamily, "not chosen");
  setSum("track", trackRec ? `${track} (${trackRec.rounds} rounds)` : "", "follows the family");
  setSum("approach", approachLabel(d.approach), "not chosen");
  setSum("approachDetail", d.approachDetail.trim(), "not written");
  setSum("model", d.model, "not chosen");
  setSum("token", d.tokenName.trim() || symbol ? `${d.tokenName.trim() || "(no name)"} · ${symbol || "(no symbol)"}` : "", "not named");
  setSum("image", state.imageFile ? state.imageFile.name : "", "not added");

  setIndex("wallet", state.owner ? shortAddress(state.owner) : "not connected", Boolean(state.owner));
  setIndex("family", trackRec ? `${family.family} r${trackRec.rounds}` : "not chosen", Boolean(trackRec));
  const approachDone = Boolean(d.approach && d.model && d.approachDetail.trim().length >= LIMITS.approachDetail.min);
  setIndex("approach", approachDone ? "written" : "not finished", approachDone);
  const tokenDone = Boolean(symbol && d.tokenName.trim() && state.imageFile);
  setIndex("token", symbol ? (state.imageFile ? symbol : `${symbol}, no image`) : "not named", tokenDone);

  const n = d.approachDetail.trim().length;
  write($("detail-count"), `${n} of ${LIMITS.approachDetail.max}`, { animate: false });
}

// Any edit invalidates the last check and its preview.
function invalidateCheck() {
  if (!$("preview").hidden) {
    $("preview").hidden = true;
    setIndex("check", "not checked", false);
  }
}

$("entry").addEventListener("change", (e) => {
  if (e.target.name === "hashFamily") renderTracks();
  if (e.target.name) clearError(e.target.name);
  if (e.target.name === "hashFamily") clearError("track");
  if (e.target.id === "token-image") onImagePicked();
  invalidateCheck();
  refresh();
});
$("entry").addEventListener("input", (e) => {
  if (e.target.id === "token-symbol") {
    // Uppercase as typed and drop anything outside A–Z0–9, keeping the caret in place.
    const el = e.target;
    const pos = el.selectionStart;
    const before = el.value;
    const next = before.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (next !== before) {
      el.value = next;
      const removed = before.slice(0, pos).toUpperCase().replace(/[A-Z0-9]/g, "").length;
      el.setSelectionRange(pos - removed, pos - removed);
    }
  }
  if (e.target.name) clearError(e.target.name);
  invalidateCheck();
  refresh();
});

// ---------------------------------------------------------------------------
// Part 5: check the entry, then preview the launch transaction (never signs, never sends)
// ---------------------------------------------------------------------------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...children);
  return node;
}

function renderPreview(source, built, ram) {
  const box = $("preview");
  const body = $("preview-body");
  $("preview-source").textContent = source;
  body.replaceChildren();

  const entry = el("p", {}, "The entry passed every check", ram?.id ? ` and was recorded as ${ram.id}.` : ".");
  body.append(entry);

  const b = built.body;
  if (b?.ok && b.transaction) {
    const t = b.transaction;
    body.append(
      el("dl", { class: "preview-facts" },
        el("dt", {}, "Size"), el("dd", {}, `${t.sizeBytes} bytes, version ${t.version}`),
        el("dt", {}, "Signers"), el("dd", {}, (t.requiredSigners || []).map(shortAddress).join(", ") + " (your wallet, then the new mint)"),
      ),
      el("ol", { class: "preview-ix", "aria-label": "Instructions in the transaction" },
        ...(t.instructions || []).map((ix) => el("li", {}, ix.label, el("span", { class: "ix-program" }, ix.programId))),
      ),
      el("p", {}, "Preview only. Nothing was signed or sent."),
    );
  } else if (b?.error === "lookup_table_required") {
    body.append(
      el("p", {}, el("span", { class: "preview-code" }, "lookup_table_required"), ` (${b.sizeBytes} bytes). `, b.message || ""),
      el("p", {}, "This is the honest reason signing is off: the transaction cannot be sent until the operator sets up an address lookup table."),
    );
  } else {
    body.append(el("p", {}, el("span", { class: "preview-code" }, b?.error || `HTTP ${built.status}`), " ", b?.message || "The transaction preview did not come back."));
  }
  box.hidden = false;
  ink(box);
}

// The preview needs a mint public key. It is generated in the browser and its secret is
// dropped at once: a preview mint never signs anything.
async function previewMint() {
  const web3 = await loadWeb3();
  return web3.Keypair.generate().publicKey.toBase58();
}

$("entry").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (state.checking) return;
  const draft = readDraft();
  const check = validateDraft(draft);
  showErrors(check.errors);
  if (!check.ok) {
    setIndex("check", "needs another look", false);
    $("preview").hidden = true;
    return;
  }

  state.checking = true;
  const btn = $("check-btn");
  btn.disabled = true;
  btn.textContent = "Checking…";
  try {
    const imageId = await ensureImageUploaded();
    if (!imageId) {
      setIndex("check", "needs another look", false);
      $("preview").hidden = true;
      return;
    }
    const created = await api.createRam(toRamRequest({ ...draft, image: imageId }));
    if (created.status !== 201 || !created.body?.ok) {
      const fields = created.body?.fields || {};
      // The server no longer holds that image (e.g. it restarted): upload it again next time.
      if (fields.image) state.uploaded = null;
      showErrors(fields);
      setIndex("check", "needs another look", false);
      if (!Object.keys(fields).length) {
        renderPreview(sourceLabel(created.mock), { status: created.status, body: created.body }, null);
      } else {
        $("preview").hidden = true;
      }
      return;
    }
    const ram = created.body.ram;
    const built = await api.buildTransaction(ram.id, await previewMint());
    state.ramId = ram.id;
    renderPreview(sourceLabel(built.mock), built, ram);
    setIndex("check", "checked", true);
  } catch (err) {
    renderPreview(sourceLabel(!(await backendReady)), { status: 0, body: { error: "unreachable", message: "The server could not be reached. Your answers are still in the slip; try again." } }, null);
    setIndex("check", "not checked", false);
    console.warn("launch check failed:", err);
  } finally {
    state.checking = false;
    btn.disabled = false;
    btn.textContent = "Check the entry";
  }
});

const sourceLabel = (mock) =>
  mock ? "Answer from the page's own built-in fallback (no backend reached), not the real server." : "Answer from the HashRammers server.";

// ---------------------------------------------------------------------------
// Part 6: signing. Not live: the button stays disabled and the handoff below refuses to run.
// ---------------------------------------------------------------------------

let web3Promise = null;
/** Loads the vendored @solana/web3.js IIFE (exposes window.solanaWeb3) once, on demand. */
export function loadWeb3() {
  if (window.solanaWeb3) return Promise.resolve(window.solanaWeb3);
  web3Promise ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "vendor/solana-web3.iife.min.js";
    s.async = true;
    s.onload = () => (window.solanaWeb3 ? resolve(window.solanaWeb3) : reject(new Error("solanaWeb3 missing after load")));
    s.onerror = () => {
      web3Promise = null;
      reject(new Error("could not load vendor/solana-web3.iife.min.js"));
    };
    document.head.append(s);
  });
  return web3Promise;
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Tells the server about a just-sent launch signature (POST .../report-signature) so it can
 * verify it for real on chain and activate the RAM itself -- no operator has to find the
 * signature and confirm by hand. Retries on a 202 ("not found yet", not a refusal): the
 * server's own RPC call can lag a moment behind the browser's. Never throws: a failed report
 * must not make the click handler show "the transaction was not sent" when the real send
 * above already succeeded -- the RAM just stays 'awaiting-signature' until it's retried
 * (reloading the slip and signing again re-sends buildTransaction, which is harmless; or the
 * operator's admin /confirm route still works as the fallback it always was).
 */
async function reportSignatureWithRetry(ramId, signature, { attempts = 4, delayMs = 2500 } = {}) {
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    try {
      const res = await api.reportSignature(ramId, signature);
      if (res.status === 200 && res.body?.ok) return { activated: true, ram: res.body.ram };
      if (res.status !== 202) return { activated: false, reason: res.body?.message || res.body?.error || `HTTP ${res.status}` };
      // 202 'not_found': the signature may still be confirming; try again.
    } catch {
      // A network hiccup reporting it is not the same as the launch failing; keep trying.
    }
  }
  return { activated: false, reason: "not confirmed by the server yet; it may still land" };
}

/**
 * The live handoff: sign and send one launch transaction for an already-created RAM, then
 * report the signature so the server can verify it on chain and activate the RAM itself.
 *
 * NOT EXERCISED against a real wallet or cluster; it cannot run while the launchpad is not
 * live, the guard below throws first. Order of operations:
 *   1. generate the mint keypair here, in the browser (its secret never leaves this function);
 *   2. ask the API to build the transaction for that mint's public key;
 *   3. Phantom signs as the owner (provider.signTransaction), then the mint signs;
 *   4. send the raw bytes with Connection.sendRawTransaction;
 *   5. wait for it to confirm, then report the signature (see reportSignatureWithRetry above).
 *
 * CSP note: the page's connect-src must allow the RPC URL used here (server/app.js's PAGE_CSP).
 */
export async function signAndSendLaunch({ provider, ramId, rpcUrl } = {}) {
  if (!isLive()) throw new Error("The launchpad is not live: signing is switched off.");
  if (!provider || !state.owner) throw new Error("Connect Phantom first.");
  if (!ramId) throw new Error("Check the entry first: no RAM id.");

  const web3 = await loadWeb3();
  const mintKeypair = web3.Keypair.generate();
  const built = await api.buildTransaction(ramId, mintKeypair.publicKey.toBase58());
  if (built.status !== 200 || !built.body?.ok || !built.body.transaction?.base64) {
    throw new Error(built.body?.message || `The transaction could not be built (${built.body?.error || built.status}).`);
  }
  const tx = web3.VersionedTransaction.deserialize(base64ToBytes(built.body.transaction.base64));
  const signedTx = await provider.signTransaction(tx);
  signedTx.sign([mintKeypair]);
  const connection = new web3.Connection(rpcUrl || web3.clusterApiUrl(state.config.cluster), "confirmed");
  const signature = await connection.sendRawTransaction(signedTx.serialize());
  try {
    await connection.confirmTransaction(signature, "confirmed");
  } catch {
    // Either it genuinely failed to confirm, or this RPC call itself timed out while the
    // transaction still lands; reportSignatureWithRetry checks the real chain state either way.
  }
  const report = await reportSignatureWithRetry(ramId, signature);
  return { signature, ...report };
}

function renderSignState() {
  const live = isLive();
  $("sign-btn").disabled = !live;
  $("sign-live-mark").hidden = live;
  $("head-live-mark").textContent = live ? "Live now" : "Not live yet";
  $("not-live-reason").hidden = live;
  setIndex("sign", live ? "live now" : "switched off", false);
  const note = $("event-note");
  if (note) {
    note.textContent = live
      ? "Live now. Fill in the slip, check it, and sign in Phantom to launch for real."
      : "Not live yet. You can fill in and check the whole slip; the signing line stays switched off until the operator finishes the last setup step. Nothing here claims a hash function is broken.";
  }
  document.title = live
    ? "Enter a RAM: HashRammers entry slip (live now)"
    : "Enter a RAM: HashRammers entry slip (not live yet)";
}

$("sign-btn").addEventListener("click", async () => {
  // Never reached while not live: the button is disabled and signAndSendLaunch would throw.
  if (!isLive()) return;
  const btn = $("sign-btn");
  btn.disabled = true;
  btn.textContent = "Waiting for Phantom…";
  try {
    const { signature, activated, reason } = await signAndSendLaunch({ provider: state.provider, ramId: state.ramId, rpcUrl: state.config?.rpcUrl });
    setIndex("sign", activated ? `live: ${shortAddress(signature)}` : `sent ${shortAddress(signature)} (${reason || "confirming"})`, true);
  } catch (err) {
    setIndex("sign", "not sent", false);
    showError("sign", err?.message || "The transaction was not sent.");
  } finally {
    btn.disabled = !isLive();
    btn.textContent = "Sign in Phantom";
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function applyConfig() {
  const c = state.config;
  const fee = c?.createFeeSol ?? CREATE_FEE_SOL;
  $("fee-sol").textContent = fee;
  for (const n of document.querySelectorAll("[data-fee]")) n.textContent = fee;
  for (const n of document.querySelectorAll("[data-treasury]")) n.textContent = c?.treasury ?? TREASURY;
  $("head-cluster").textContent = `cluster: ${c?.cluster ?? "mainnet-beta"}`;
  if (c?.limits?.approachDetail?.max) $("approach-detail").maxLength = c.limits.approachDetail.max;
  const imageMax = (c?.image?.maxBytes ?? IMAGE_LIMITS.maxBytes) / 1024 / 1024;
  for (const n of document.querySelectorAll("[data-image-max]")) n.textContent = String(imageMax);
  $("mock-note").hidden = !state.configIsMock;
}

async function boot() {
  try {
    const res = await api.getConfig();
    if (res.status === 200 && res.body?.ok) {
      state.config = res.body.launchpad;
      state.configIsMock = res.mock;
    }
  } catch (err) {
    console.warn("launchpad config unavailable, using the built-in rules:", err);
  }
  applyConfig();
  renderChoices();
  renderSignState();
  refresh();

  // Phantom can inject after the page's scripts run; look again once the page has loaded.
  if (findPhantom()) initWallet();
  else if (document.readyState === "complete") setTimeout(initWallet, 400);
  else window.addEventListener("load", () => setTimeout(initWallet, 400), { once: true });
}

boot();

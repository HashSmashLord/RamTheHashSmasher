// HashRammers: the idea slip (/submit). Ideas go to the human review queue, never straight
// to a RAM. Data through RAMherdAPI only.

import { RAMherdAPI, updateDemoNote } from "./mock-data.js";
import { $ } from "./ui.js";

export function mountIdeaSlip() {
  updateDemoNote("Handing in posts to the real human-review queue. Nothing reaches a RAM until a person approves it.");
  const ideaForm = $("idea-form");
  const ideaConfirm = $("idea-confirm");
  const ideaConfirmText = $("idea-confirm-text");
  const handInButton = ideaForm.querySelector("button[type=submit]");

  ideaForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = new FormData(ideaForm);
    const payload = { track: data.get("track"), idea: data.get("idea"), contact: data.get("contact") };

    handInButton.disabled = true;
    handInButton.textContent = "Handing in…";

    try {
      const result = await RAMherdAPI.submitIdea(payload);
      if (result.status === "rejected") {
        ideaConfirmText.textContent = `Not queued: ${result.reason || "it did not pass the automatic screen."} You can edit it and try again.`;
      } else {
        ideaConfirmText.textContent = result.queuePosition != null
          ? `Queued for human review, position ${result.queuePosition}. No RAM sees it until a reviewer approves it.`
          : "Queued for human review. No RAM sees it until a reviewer approves it.";
        ideaForm.reset();
      }
      ideaConfirm.classList.add("is-visible");
    } catch {
      ideaConfirmText.textContent = "It did not go through. Your text is still in the form; try handing it in again.";
      ideaConfirm.classList.add("is-visible");
    } finally {
      handInButton.disabled = false;
      handInButton.textContent = "Hand in for review";
    }
  });
}

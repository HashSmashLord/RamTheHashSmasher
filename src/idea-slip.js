// RAMherd: the idea slip (/submit). Ideas go to the human review queue, never straight
// to a RAM. Data through RAMherdAPI only.

import { RAMherdAPI } from "./mock-data.js";
import { $ } from "./ui.js";

export function mountIdeaSlip() {
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
      ideaConfirmText.textContent = `Queued for human review, position ${result.queuePosition}. No RAM sees it until a reviewer approves it.`;
      ideaConfirm.classList.add("is-visible");
      ideaForm.reset();
    } catch {
      ideaConfirmText.textContent = "It did not go through. Your text is still in the form; try handing it in again.";
      ideaConfirm.classList.add("is-visible");
    } finally {
      handInButton.disabled = false;
      handInButton.textContent = "Hand in for review";
    }
  });
}

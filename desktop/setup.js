const form = window.document.querySelector("form");
const input = window.document.querySelector("input");
const button = window.document.querySelector("button");
const buttonLabel = window.document.querySelector(".button-label");
const status = window.document.querySelector("#login-status");
window.qm.onLoginStatus((message) => {
  status.textContent = message;
});
const error = window.document.querySelector("#error");

window.qm
  .currentInstance()
  .then((result) => {
    input.value = result.url;
    status.textContent = result.status;
  })
  .catch((reason) => {
    error.textContent = reason.message;
  });
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  button.disabled = true;
  buttonLabel.textContent = "Connecting…";
  input.removeAttribute("aria-invalid");
  error.textContent = "";
  try {
    const result = await window.qm.connect(input.value.trim());
    if (result.error) {
      error.textContent = result.error;
      input.setAttribute("aria-invalid", "true");
      input.focus();
    }
  } catch (reason) {
    error.textContent = reason.message;
  } finally {
    button.disabled = false;
    buttonLabel.textContent = "Open QM";
  }
});

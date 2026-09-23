const form = document.querySelector("#connection-form");
const originInput = document.querySelector("#server-origin");
const connectButton = document.querySelector("#connect-button");
const connectionStatus = document.querySelector("#connection-status");
const connectionError = document.querySelector("#connection-error");
const bridge = window.yakjevDesktop;

const showError = (message) => {
  connectionStatus.textContent = "";
  connectionError.textContent = message;
  connectionError.hidden = false;
};

if (bridge) {
  connectButton.disabled = false;
} else {
  showError("The desktop connection is unavailable. Close and reopen Yakjev.");
}

originInput.addEventListener("input", () => {
  if (!bridge) return;
  connectionError.hidden = true;
  connectionError.textContent = "";
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!bridge || connectButton.disabled) return;

  connectionError.hidden = true;
  connectionError.textContent = "";
  connectionStatus.textContent = "Connecting to your server…";
  form.setAttribute("aria-busy", "true");
  connectButton.disabled = true;
  originInput.readOnly = true;

  let connected = false;
  try {
    const result = await bridge.connect(originInput.value.trim());
    if (result.ok) {
      connected = true;
      connectionStatus.textContent = "Opening your workspace…";
    } else {
      showError(result.message);
    }
  } catch {
    showError(
      "Couldn’t open your workspace. Check the server address and try again.",
    );
  } finally {
    if (!connected) {
      form.removeAttribute("aria-busy");
      connectButton.disabled = false;
      originInput.readOnly = false;
      originInput.focus();
    }
  }
});

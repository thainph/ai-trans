const apiKeyInput = document.getElementById("apiKey");
const toggleKeyBtn = document.getElementById("toggleKey");
const saveKeyBtn = document.getElementById("saveKey");
const statusEl = document.getElementById("status");
const styleRadios = document.querySelectorAll('input[name="style"]');
const targetLangSelect = document.getElementById("targetLang");

// Load saved settings
chrome.storage.sync.get(["apiKey", "style", "targetLang"], (data) => {
  if (data.apiKey) apiKeyInput.value = data.apiKey;
  if (data.style) {
    const radio = document.querySelector(`input[name="style"][value="${data.style}"]`);
    if (radio) radio.checked = true;
  }
  if (data.targetLang) targetLangSelect.value = data.targetLang;
});

// Toggle API key visibility
toggleKeyBtn.addEventListener("click", () => {
  apiKeyInput.type = apiKeyInput.type === "password" ? "text" : "password";
});

// Save API key
saveKeyBtn.addEventListener("click", () => {
  const key = apiKeyInput.value.trim();
  if (!key) {
    showStatus("Please enter an API key", "error");
    return;
  }
  chrome.storage.sync.set({ apiKey: key }, () => {
    showStatus("API key saved!", "success");
  });
});

// Save style on change
styleRadios.forEach((radio) => {
  radio.addEventListener("change", (e) => {
    chrome.storage.sync.set({ style: e.target.value }, () => {
      showStatus("Style updated!", "success");
    });
  });
});

// Save target language on change
targetLangSelect.addEventListener("change", (e) => {
  chrome.storage.sync.set({ targetLang: e.target.value }, () => {
    showStatus("Target language updated!", "success");
  });
});

function showStatus(message, type) {
  statusEl.textContent = message;
  statusEl.className = `status ${type}`;
  setTimeout(() => {
    statusEl.className = "status hidden";
  }, 2000);
}

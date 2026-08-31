document.addEventListener("DOMContentLoaded", async () => {
  const input = document.getElementById("token-input");
  const saveBtn = document.getElementById("save-btn");
  const clearBtn = document.getElementById("clear-btn");
  const savedMsg = document.getElementById("saved");

  const { token } = await chrome.runtime.sendMessage({ type: "GET_TOKEN" });
  if (token) input.value = token;

  saveBtn.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "SET_TOKEN", token: input.value.trim() });
    savedMsg.style.display = "block";
    setTimeout(() => (savedMsg.style.display = "none"), 2000);
  });

  clearBtn.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "CLEAR_TOKEN" });
    input.value = "";
  });
});

const { invoke } = window.__TAURI__.core;

document.getElementById("open-folder").addEventListener("submit", async (event) => {
  event.preventDefault();
  const list = document.getElementById("entries");
  const error = document.getElementById("error");
  list.replaceChildren();
  error.textContent = "";
  try {
    const entries = await invoke("list_dir", { path: document.getElementById("folder-path").value });
    for (const entry of entries) {
      const item = document.createElement("li");
      item.textContent = entry.is_dir ? `${entry.name}/` : entry.name;
      list.append(item);
    }
  } catch (message) {
    error.textContent = message;
  }
});

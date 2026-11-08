const modeInputs = [...document.querySelectorAll('input[name=mode]')];
const onExistingInputs = [...document.querySelectorAll('input[name=onExisting]')];
const openModeInputs = [...document.querySelectorAll('input[name=openMode]')];
const subfolderInput = document.querySelector('#subfolder');
const organizeInput = document.querySelector('#organize');
const minSizeInput = document.querySelector('#minSize');
const autoScrollInput = document.querySelector('#autoScroll');
const folderNameEl = document.querySelector('#folderName');
const permissionEl = document.querySelector('#permission');
const pickButton = document.querySelector('#pickFolder');
const grantButton = document.querySelector('#grant');
const exampleEl = document.querySelector('#example');
const toastEl = document.querySelector('#toast');

const EXAMPLE = {
  folder: 'pixiv/作者_71413017/119997896_作品標題',
  image: { filename: '119997896_p0.png' }
};

let settings = DEFAULT_SETTINGS;
let handle = null;
let toastTimer = null;

function toast(text) {
  toastEl.textContent = text;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1600);
}

async function update(patch) {
  settings = await saveSettings(patch);
  render();
  toast('已儲存');
}

async function renderPermission() {
  if (!handle) {
    permissionEl.textContent = '';
    permissionEl.className = 'badge';
    grantButton.hidden = true;
    return;
  }
  const state = await handle.queryPermission({ mode: 'readwrite' });
  const granted = state === 'granted';
  permissionEl.textContent = granted ? '可寫入' : '需要重新允許';
  permissionEl.className = `badge ${granted ? 'ok' : 'warn'}`;
  grantButton.hidden = granted;
}

function render() {
  modeInputs.forEach(input => { input.checked = input.value === settings.mode; });
  onExistingInputs.forEach(input => { input.checked = input.value === settings.onExisting; });
  openModeInputs.forEach(input => { input.checked = input.value === settings.openMode; });
  document.querySelectorAll('.detail').forEach(el => { el.hidden = el.dataset.for !== settings.mode; });
  if (document.activeElement !== subfolderInput) subfolderInput.value = settings.subfolder;
  organizeInput.checked = settings.organize;
  if (document.activeElement !== minSizeInput) minSizeInput.value = settings.minSize;
  autoScrollInput.checked = settings.autoScroll;
  folderNameEl.textContent = handle ? handle.name : '尚未選擇';

  const root = settings.mode === 'custom' ? (handle ? handle.name : '（自選資料夾）') : '下載';
  exampleEl.textContent = [root, ...buildPathParts({ settings, ...EXAMPLE, index: 0 })].join(' / ');
  renderPermission();
}

modeInputs.forEach(input => input.addEventListener('change', () => update({ mode: input.value })));
onExistingInputs.forEach(input => input.addEventListener('change', () => update({ onExisting: input.value })));
openModeInputs.forEach(input => input.addEventListener('change', () => update({ openMode: input.value })));
organizeInput.addEventListener('change', () => update({ organize: organizeInput.checked }));
autoScrollInput.addEventListener('change', () => update({ autoScroll: autoScrollInput.checked }));
minSizeInput.addEventListener('change', () => {
  const value = Math.max(0, Math.round(Number(minSizeInput.value) || 0));
  minSizeInput.value = value;
  update({ minSize: value });
});
subfolderInput.addEventListener('change', () => update({ subfolder: splitFolder(subfolderInput.value).join('/') }));
subfolderInput.addEventListener('input', () => {
  settings = { ...settings, subfolder: subfolderInput.value };
  render();
});

pickButton.addEventListener('click', async () => {
  try {
    const picked = await showDirectoryPicker({ id: 'image-batch-downloader', mode: 'readwrite', startIn: 'pictures' });
    await setDirectoryHandle(picked);
    handle = picked;
    await update({ mode: 'custom' });
  } catch (error) {
    if (error.name !== 'AbortError') toast(`無法使用這個資料夾：${error.message}`);
  }
});

grantButton.addEventListener('click', async () => {
  await handle?.requestPermission({ mode: 'readwrite' });
  renderPermission();
});

document.querySelector('#openChromeSettings').addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://settings/downloads' });
});

(async () => {
  settings = await loadSettings();
  render();
  handle = (await getDirectoryHandle().catch(() => null)) || null;
  render();
})();

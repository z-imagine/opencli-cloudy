const dot = document.getElementById('dot');
const status = document.getElementById('status');
const meta = document.getElementById('meta');
const hint = document.getElementById('hint');
const form = document.getElementById('config-form');
const backendUrlInput = document.getElementById('backend-url');
const tokenInput = document.getElementById('token');
const saveButton = document.getElementById('save');
const saveStatus = document.getElementById('save-status');
const backendDisplay = document.getElementById('backend-display');
const clientIdDisplay = document.getElementById('client-id-display');
let refreshTimer = null;

function setSaveStatus(message, isError = false) {
  saveStatus.textContent = message;
  saveStatus.style.color = isError ? '#d93025' : '#666';
}

function renderStatus(resp) {
  backendUrlInput.value = resp.backendUrl || '';
  tokenInput.value = resp.token || '';
  backendDisplay.textContent = resp.backendUrl || '未配置';
  clientIdDisplay.textContent = resp.clientId || '未分配';

  if (resp.connected) {
    dot.className = 'dot connected';
    status.innerHTML = '<strong>已连接远程 Bridge</strong>';
  } else if (resp.reconnecting || resp.state === 'connecting') {
    dot.className = 'dot connecting';
    status.innerHTML = '<strong>正在重连远程 Bridge</strong>';
  } else {
    dot.className = 'dot disconnected';
    status.innerHTML = '<strong>未连接远程 Bridge</strong>';
  }

  const lines = [];
  if (!resp.token) lines.push('固定 Token：未配置');
  if (resp.lastError) lines.push(`错误：${resp.lastError}`);
  meta.textContent = lines.join('\n');
  hint.style.display = resp.backendUrl && resp.token ? 'none' : 'block';
}

function fetchStatus() {
  chrome.runtime.sendMessage({ type: 'getStatus' }, (resp) => {
    if (chrome.runtime.lastError || !resp) {
      dot.className = 'dot disconnected';
      status.innerHTML = '<strong>无法读取扩展状态</strong>';
      meta.textContent = chrome.runtime.lastError?.message || '';
      backendDisplay.textContent = backendUrlInput.value || '未配置';
      clientIdDisplay.textContent = '未分配';
      hint.style.display = 'block';
      return;
    }
    renderStatus(resp);
  });
}

function startStatusPolling() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(fetchStatus, 1000);
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  saveButton.disabled = true;
  setSaveStatus('正在保存...');

  chrome.runtime.sendMessage({
    type: 'saveConfig',
    backendUrl: backendUrlInput.value.trim(),
    token: tokenInput.value.trim(),
  }, (resp) => {
    saveButton.disabled = false;
    if (chrome.runtime.lastError || !resp || resp.ok === false) {
      setSaveStatus(chrome.runtime.lastError?.message || resp?.error || '保存失败', true);
      return;
    }
    renderStatus(resp);
    setSaveStatus('已保存，扩展正在尝试连接');
  });
});

fetchStatus();
startStatusPolling();

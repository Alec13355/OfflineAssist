import * as vscode from 'vscode';

export interface IChatModelProvider {
	getModels(): Promise<Array<{ id: string; name: string; isCached: boolean; sizeMb?: number; supportsToolCalling: boolean }>>;
	chat(
		modelId: string,
		mode: 'agent' | 'plan' | 'yolo',
		history: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>,
		onChunk: (text: string) => void,
		token: vscode.CancellationToken,
	): Promise<void>;
}

export class ChatPanel {
	public static currentPanel: ChatPanel | undefined;
	private static readonly viewType = 'offlineAssistChat';

	private readonly panel: vscode.WebviewPanel;
	private readonly disposables: vscode.Disposable[] = [];
	private cancelSource: vscode.CancellationTokenSource | undefined;
	private history: Array<{ role: 'user' | 'assistant'; content: string }> = [];

	public static createOrShow(provider: IChatModelProvider): void {
		const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

		if (ChatPanel.currentPanel) {
			ChatPanel.currentPanel.panel.reveal(column);
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			ChatPanel.viewType,
			'OfflineAssist Chat',
			column,
			{ enableScripts: true, retainContextWhenHidden: true },
		);

		ChatPanel.currentPanel = new ChatPanel(panel, provider);
	}

	private constructor(
		panel: vscode.WebviewPanel,
		private readonly provider: IChatModelProvider,
	) {
		this.panel = panel;
		this.panel.webview.html = this.getHtml();
		this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
		this.panel.webview.onDidReceiveMessage(async (msg: { type: string; text?: string; modelId?: string; mode?: 'agent' | 'plan' | 'yolo' }) => {
			if (msg.type === 'ready') {
				await this.sendModels();
			} else if (msg.type === 'send' && msg.text && msg.modelId && msg.mode) {
				await this.handleSend(msg.modelId, msg.mode, msg.text);
			} else if (msg.type === 'cancel') {
				this.cancelSource?.cancel();
			} else if (msg.type === 'clear') {
				this.history = [];
			}
		}, null, this.disposables);
	}

	private async sendModels(): Promise<void> {
		try {
			const models = await this.provider.getModels();
			void this.panel.webview.postMessage({ type: 'models', models });
		} catch (err) {
			void this.panel.webview.postMessage({ type: 'models', models: [] });
		}
	}

	private async handleSend(modelId: string, mode: 'agent' | 'plan' | 'yolo', text: string): Promise<void> {
		this.cancelSource?.cancel();
		this.cancelSource = new vscode.CancellationTokenSource();
		const token = this.cancelSource.token;

		this.history.push({ role: 'user', content: text });
		void this.panel.webview.postMessage({ type: 'start' });

		let responseText = '';
		try {
			await this.provider.chat(
				modelId,
				mode,
				this.history,
				(chunk: string) => {
					responseText += chunk;
					void this.panel.webview.postMessage({ type: 'chunk', text: chunk });
				},
				token,
			);
			this.history.push({ role: 'assistant', content: responseText });
		} catch (err) {
			if (!token.isCancellationRequested) {
				const message = err instanceof Error ? err.message : String(err);
				void this.panel.webview.postMessage({ type: 'error', message });
			}
		} finally {
			void this.panel.webview.postMessage({ type: 'done' });
		}
	}

	public dispose(): void {
		ChatPanel.currentPanel = undefined;
		this.cancelSource?.cancel();
		this.panel.dispose();
		for (const d of this.disposables) {
			d.dispose();
		}
		this.disposables.length = 0;
	}

	private getHtml(): string {
		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<title>OfflineAssist Chat</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
	font-family: var(--vscode-font-family);
	font-size: var(--vscode-font-size);
	color: var(--vscode-foreground);
	background: var(--vscode-editor-background);
	display: flex;
	flex-direction: column;
	height: 100vh;
	overflow: hidden;
}
#toolbar {
	padding: 8px 12px;
	border-bottom: 1px solid var(--vscode-panel-border);
	display: flex;
	flex-direction: column;
	align-items: stretch;
	gap: 8px;
	flex-shrink: 0;
}
#modeRow {
	display: flex;
	align-items: center;
	gap: 8px;
}
#modelRow {
	display: flex;
	align-items: center;
	gap: 8px;
}
#toolbar label { font-size: 12px; color: var(--vscode-descriptionForeground); white-space: nowrap; }
#modeSelect,
#modelSelect {
	flex: 1;
	background: var(--vscode-dropdown-background);
	color: var(--vscode-dropdown-foreground);
	border: 1px solid var(--vscode-dropdown-border);
	padding: 4px 6px;
	font-size: 12px;
	border-radius: 2px;
}
#clearBtn {
	background: transparent;
	color: var(--vscode-descriptionForeground);
	border: 1px solid var(--vscode-panel-border);
	padding: 4px 10px;
	cursor: pointer;
	font-size: 12px;
	border-radius: 2px;
	white-space: nowrap;
}
#clearBtn:hover { background: var(--vscode-toolbar-hoverBackground); }
#messages {
	flex: 1;
	overflow-y: auto;
	padding: 16px 12px;
	display: flex;
	flex-direction: column;
	gap: 14px;
}
#emptyState {
	flex: 1;
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	color: var(--vscode-descriptionForeground);
	gap: 10px;
	text-align: center;
	padding: 24px;
}
.message { display: flex; flex-direction: column; gap: 4px; max-width: 88%; }
.message.user { align-self: flex-end; align-items: flex-end; }
.message.assistant { align-self: flex-start; align-items: flex-start; }
.message-role {
	font-size: 11px;
	color: var(--vscode-descriptionForeground);
	text-transform: uppercase;
	letter-spacing: 0.06em;
	font-weight: 600;
}
.message-bubble {
	padding: 8px 12px;
	border-radius: 6px;
	white-space: pre-wrap;
	word-break: break-word;
	line-height: 1.55;
}
.message.user .message-bubble {
	background: var(--vscode-button-background);
	color: var(--vscode-button-foreground);
}
.message.assistant .message-bubble {
	background: var(--vscode-input-background);
	border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
}
.cursor {
	display: inline-block;
	width: 2px;
	height: 0.9em;
	background: currentColor;
	animation: blink 1s step-end infinite;
	vertical-align: text-bottom;
	margin-left: 1px;
}
@keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }
#inputArea {
	border-top: 1px solid var(--vscode-panel-border);
	padding: 10px 12px;
	display: flex;
	gap: 8px;
	flex-shrink: 0;
}
#input {
	flex: 1;
	background: var(--vscode-input-background);
	color: var(--vscode-input-foreground);
	border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
	padding: 6px 10px;
	border-radius: 4px;
	font-family: inherit;
	font-size: inherit;
	resize: none;
	min-height: 36px;
	max-height: 140px;
	overflow-y: auto;
}
#input:focus { outline: 1px solid var(--vscode-focusBorder); border-color: var(--vscode-focusBorder); }
#input::placeholder { color: var(--vscode-input-placeholderForeground); }
#sendBtn {
	background: var(--vscode-button-background);
	color: var(--vscode-button-foreground);
	border: none;
	padding: 6px 16px;
	cursor: pointer;
	border-radius: 4px;
	font-size: inherit;
	font-family: inherit;
	align-self: flex-end;
	min-width: 64px;
}
#sendBtn:hover { background: var(--vscode-button-hoverBackground); }
#sendBtn:disabled { opacity: 0.5; cursor: default; }
#sendBtn.stop { background: var(--vscode-inputValidation-errorBackground, #5a1d1d); }
</style>
</head>
<body>
<div id="toolbar">
	<div id="modeRow">
		<label for="modeSelect">Mode:</label>
		<select id="modeSelect" aria-label="Chat mode">
			<option value="agent">Agent</option>
			<option value="plan">Plan</option>
			<option value="yolo">Yolo</option>
		</select>
	</div>
	<div id="modelRow">
		<label for="modelSelect">Model:</label>
		<select id="modelSelect"><option value="">Loading models…</option></select>
		<button id="clearBtn">Clear chat</button>
	</div>
</div>
<div id="messages">
	<div id="emptyState">
		<span style="font-size:36px">🤖</span>
		<span style="font-size:15px;font-weight:600">OfflineAssist Chat</span>
		<span>Pick Agent, Plan, or Yolo, then choose a model and start chatting.<br>Your conversation stays on-device.</span>
	</div>
</div>
<div id="inputArea">
	<textarea id="input" rows="1" placeholder="Ask anything… (Enter to send, Shift+Enter for newline)"></textarea>
	<button id="sendBtn">Send</button>
</div>
<script>
const vscode = acquireVsCodeApi();
const messagesEl = document.getElementById('messages');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('sendBtn');
const modelSelect = document.getElementById('modelSelect');
const clearBtn = document.getElementById('clearBtn');
const emptyState = document.getElementById('emptyState');
const modeSelect = document.getElementById('modeSelect');
let currentMode = 'agent';
let allModels = [];
let streaming = false;
let activeBubble = null;
const inputHistory = [];
let historyIndex = -1;
let savedDraft = '';

vscode.postMessage({ type: 'ready' });

window.addEventListener('message', e => {
	const msg = e.data;
	if (msg.type === 'models') {
		allModels = Array.isArray(msg.models) ? msg.models : [];
		renderModels();
	} else if (msg.type === 'start') {
		streaming = true;
		sendBtn.textContent = 'Stop';
		sendBtn.classList.add('stop');
		sendBtn.disabled = false;
		activeBubble = appendMessage('assistant', '');
		scrollBottom();
	} else if (msg.type === 'chunk') {
		if (activeBubble) {
			const cursor = activeBubble.querySelector('.cursor');
			if (cursor) { cursor.remove(); }
			activeBubble.appendChild(document.createTextNode(msg.text));
			activeBubble.appendChild(Object.assign(document.createElement('span'), { className: 'cursor' }));
			scrollBottom();
		}
	} else if (msg.type === 'done') {
		streaming = false;
		sendBtn.textContent = 'Send';
		sendBtn.classList.remove('stop');
		if (activeBubble) {
			const cursor = activeBubble.querySelector('.cursor');
			if (cursor) { cursor.remove(); }
			activeBubble = null;
		}
	} else if (msg.type === 'error') {
		streaming = false;
		sendBtn.textContent = 'Send';
		sendBtn.classList.remove('stop');
		const target = activeBubble ?? appendMessage('assistant', '');
		activeBubble = null;
		const cursor = target.querySelector('.cursor');
		if (cursor) { cursor.remove(); }
		target.textContent = '';
		target.appendChild(document.createTextNode('⚠ Error: ' + msg.message));
		target.style.color = 'var(--vscode-inputValidation-errorForeground, #f48771)';
	}
});

sendBtn.addEventListener('click', () => {
	if (streaming) {
		vscode.postMessage({ type: 'cancel' });
	} else {
		send();
	}
});

inputEl.addEventListener('keydown', e => {
	if (e.key === 'Enter' && !e.shiftKey) {
		e.preventDefault();
		if (!streaming) { send(); }
		return;
	}
	if (e.key === 'ArrowUp') {
		if (inputHistory.length === 0) { return; }
		e.preventDefault();
		if (historyIndex === -1) { savedDraft = inputEl.value; }
		historyIndex = Math.min(historyIndex + 1, inputHistory.length - 1);
		setInput(inputHistory[inputHistory.length - 1 - historyIndex]);
		return;
	}
	if (e.key === 'ArrowDown') {
		if (historyIndex === -1) { return; }
		e.preventDefault();
		historyIndex--;
		setInput(historyIndex === -1 ? savedDraft : inputHistory[inputHistory.length - 1 - historyIndex]);
	}
});

inputEl.addEventListener('input', () => {
	inputEl.style.height = 'auto';
	inputEl.style.height = Math.min(inputEl.scrollHeight, 140) + 'px';
});

clearBtn.addEventListener('click', () => {
	while (messagesEl.firstChild) { messagesEl.removeChild(messagesEl.firstChild); }
	messagesEl.appendChild(emptyState);
	emptyState.style.display = '';
	vscode.postMessage({ type: 'clear' });
});

modeSelect.addEventListener('change', () => {
	setMode(modeSelect.value);
});

function send() {
	const text = inputEl.value.trim();
	const modelId = modelSelect.value;
	if (!text || !modelId) { return; }
	if (inputHistory.length === 0 || inputHistory[inputHistory.length - 1] !== text) {
		inputHistory.push(text);
		if (inputHistory.length > 100) { inputHistory.shift(); }
	}
	historyIndex = -1;
	savedDraft = '';
	appendMessage('user', text);
	setInput('');
	scrollBottom();
	vscode.postMessage({ type: 'send', text, modelId, mode: currentMode });
}

function setInput(text) {
	inputEl.value = text;
	inputEl.style.height = 'auto';
	inputEl.style.height = Math.min(inputEl.scrollHeight, 140) + 'px';
	// move cursor to end
	inputEl.selectionStart = inputEl.selectionEnd = text.length;
}

function setMode(mode) {
	if (mode !== 'agent' && mode !== 'plan' && mode !== 'yolo') {
		return;
	}
	currentMode = mode;
	modeSelect.value = mode;
	renderModels();
}

function renderModels() {
	const prev = modelSelect.value;
	const filtered = currentMode === 'plan'
		? allModels
		: allModels.filter(m => m.supportsToolCalling);

	if (!filtered.length) {
		const label = currentMode === 'plan'
			? 'No models available'
			: 'No tool-capable models available for this mode';
		modelSelect.innerHTML = '<option value="">' + label + '</option>';
		return;
	}

	modelSelect.innerHTML = filtered.map(m => {
		const toolIcon = m.supportsToolCalling ? '🛠️ ' : '';
		const status = m.isCached ? 'Local' : 'Needs download';
		const size = typeof m.sizeMb === 'number' ? ' • ' + m.sizeMb + ' MB' : '';
		return '<option value="' + esc(m.id) + '">' + toolIcon + esc(m.name) + ' — ' + status + size + '</option>';
	}).join('');

	if (prev && [...modelSelect.options].some(o => o.value === prev)) {
		modelSelect.value = prev;
	}
}

function appendMessage(role, text) {
	emptyState.style.display = 'none';
	const wrap = document.createElement('div');
	wrap.className = 'message ' + role;
	const label = document.createElement('div');
	label.className = 'message-role';
	label.textContent = role === 'user' ? 'You' : 'Assistant';
	const bubble = document.createElement('div');
	bubble.className = 'message-bubble';
	if (text) { bubble.textContent = text; }
	wrap.appendChild(label);
	wrap.appendChild(bubble);
	messagesEl.appendChild(wrap);
	return bubble;
}

function scrollBottom() {
	messagesEl.scrollTop = messagesEl.scrollHeight;
}

function esc(s) {
	return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
</script>
</body>
</html>`;
	}
}

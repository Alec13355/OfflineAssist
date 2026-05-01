import * as vscode from 'vscode';
import * as path from 'node:path';
import { FoundryLocalManager, type IModel } from 'foundry-local-sdk';
import { ChatPanel, type IChatModelProvider } from './chatPanel.js';

const providerVendor = 'offline-assist';
const downloadModelCommandId = 'offlineAssist.downloadModel';
const refreshModelsCommandId = 'offlineAssist.refreshModels';
const openChatCommandId = 'offlineAssist.openChat';
const chatToolStepLimit = 10;

type OpenAIChatMessage = {
	role: 'system' | 'user' | 'assistant';
	content: string;
};

type ChatMode = 'agent' | 'plan' | 'yolo';

type ToolCall = {
	tool: 'read_file' | 'list_files' | 'write_file' | 'replace_in_file';
	args: Record<string, unknown>;
};

class OfflineAssistLanguageModelProvider implements vscode.LanguageModelChatProvider, IChatModelProvider {
	private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
	private readonly modelCache = new Map<string, IModel>();
	private manager: FoundryLocalManager | undefined;
	private executionProvidersPromise: Promise<void> | undefined;

	public readonly onDidChangeLanguageModelChatInformation = this.onDidChangeEmitter.event;

	constructor(
		private readonly outputChannel: vscode.OutputChannel,
		private readonly statusBar: vscode.StatusBarItem,
	) {}

	public async provideLanguageModelChatInformation(_options: vscode.PrepareLanguageModelChatModelOptions, token: vscode.CancellationToken): Promise<vscode.LanguageModelChatInformation[]> {
		const models = await this.getChatModels(token);
		return models.map(model => this.toLanguageModelInfo(model));
	}

	public async provideLanguageModelChatResponse(
		model: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelTextPart>,
		token: vscode.CancellationToken,
	): Promise<void> {
		const foundryModel = await this.getModelById(model.id, token);
		await this.prepareModel(foundryModel, token);

		const chatClient = foundryModel.createChatClient();
		this.applyModelConfiguration(chatClient, options.modelConfiguration);

		const requestMessages = this.toOpenAIChatMessages(messages);
		if (!requestMessages.length) {
			throw new Error('No text messages to send to the model.');
		}

		for await (const chunk of chatClient.completeStreamingChat(requestMessages)) {
			if (token.isCancellationRequested) {
				return;
			}

			const deltaText = chunk?.choices?.[0]?.delta?.content;
			if (typeof deltaText === 'string' && deltaText.length > 0) {
				progress.report(new vscode.LanguageModelTextPart(deltaText));
			}
		}

		this.updateStatusBar(model.name);
		this.onDidChangeEmitter.fire();
	}

	public async provideTokenCount(_model: vscode.LanguageModelChatInformation, value: string | vscode.LanguageModelChatRequestMessage): Promise<number> {
		const text = typeof value === 'string' ? value : this.partsToText(value.content);
		return Math.ceil(text.length / 4);
	}

	public async downloadModelFromPicker(): Promise<void> {
		const models = await this.getChatModels();
		if (!models.length) {
			void vscode.window.showWarningMessage('No chat-capable models found for this machine. Check that Foundry Local is installed and running.');
			return;
		}

		const picked = await vscode.window.showQuickPick(
			models.map(model => ({
				label: model.info.displayName ?? model.alias,
				description: model.alias,
				detail: this.getModelDetail(model),
				model,
			})),
			{
				matchOnDescription: true,
				matchOnDetail: true,
				placeHolder: 'Choose an OfflineAssist chat model to download',
			}
		);

		if (!picked) {
			return;
		}

		await this.downloadModelOnly(picked.model);
		this.onDidChangeEmitter.fire();
		void vscode.window.showInformationMessage(`OfflineAssist model '${picked.model.alias}' is ready for chat.`);
	}

	public refreshModels(): void {
		this.modelCache.clear();
		this.onDidChangeEmitter.fire();
	}

	public async getModels(): Promise<Array<{ id: string; name: string; isCached: boolean; sizeMb?: number; supportsToolCalling: boolean }>> {
		const models = await this.getChatModels();
		const sorted = [...models].sort((left, right) => {
			if (left.isCached !== right.isCached) {
				return left.isCached ? -1 : 1;
			}

			const leftName = left.info.displayName ?? left.alias;
			const rightName = right.info.displayName ?? right.alias;
			return leftName.localeCompare(rightName);
		});

		return sorted.map(m => ({
			id: m.id,
			name: m.info.displayName ?? m.alias,
			isCached: m.isCached,
			sizeMb: typeof m.info.fileSizeMb === 'number' ? m.info.fileSizeMb : undefined,
			supportsToolCalling: m.supportsToolCalling === true,
		}));
	}

	public async chat(
		modelId: string,
		mode: ChatMode,
		history: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>,
		onChunk: (text: string) => void,
		token: vscode.CancellationToken,
	): Promise<void> {
		const model = await this.getModelById(modelId, token);
		await this.prepareModel(model, token);

		if (token.isCancellationRequested) {
			return;
		}

		const chatClient = model.createChatClient();
		const instructionContext = await this.loadWorkspaceInstructions();
		const systemPrompt = this.buildModeSystemPrompt(mode, instructionContext);
		const messages: OpenAIChatMessage[] = [
			{ role: 'system', content: systemPrompt },
			...history.map(m => ({ role: m.role, content: m.content })),
		];

		this.outputChannel.appendLine(`[chat] Mode: ${mode}`);
		this.outputChannel.appendLine(`[chat] Model: ${model.info.displayName ?? model.alias} (id: ${model.id})`);
		this.outputChannel.appendLine(`[chat] Tool support: ${model.supportsToolCalling ? 'yes' : 'no'}`);
		this.outputChannel.appendLine(`[chat] System prompt length: ${systemPrompt.length} chars`);

		for (let step = 0; step < chatToolStepLimit; step++) {
			const stepNumber = step + 1;
			this.outputChannel.appendLine(`[tools] Step ${stepNumber}/${chatToolStepLimit}: waiting for model decision.`);

			const assistantText = await this.completeText(chatClient, messages, token);
			if (token.isCancellationRequested) {
				this.outputChannel.appendLine(`[tools] Step ${stepNumber}/${chatToolStepLimit}: cancelled.`);
				return;
			}

			const responsePreview = assistantText.replace(/\n/g, ' ').slice(0, 400);
			this.outputChannel.appendLine(`[tools] Step ${stepNumber}/${chatToolStepLimit}: response: ${responsePreview}${assistantText.length > 400 ? '...' : ''}`);
			const toolCall = this.tryParseToolCall(assistantText);
			if (!toolCall) {
				this.outputChannel.appendLine(`[tools] Step ${stepNumber}/${chatToolStepLimit}: final response produced (no tool call detected).`);
				if (!assistantText.includes('```')) {
					this.outputChannel.appendLine(`[tools] Note: response contains no code block (expected for tool calls).`);
				}
				onChunk(assistantText);
				this.updateStatusBar(model.info.displayName ?? model.alias);
				return;
			}

			const argsPreview = JSON.stringify(toolCall.args).slice(0, 300);
			this.outputChannel.appendLine(`[tools] Step ${stepNumber}/${chatToolStepLimit}: calling ${toolCall.tool} with args ${argsPreview}`);
			messages.push({ role: 'assistant', content: assistantText });
			const toolResult = await this.executeToolCall(toolCall);
			const resultPreview = toolResult.replace(/\s+/g, ' ').slice(0, 300);
			this.outputChannel.appendLine(`[tools] Step ${stepNumber}/${chatToolStepLimit}: ${toolCall.tool} result ${resultPreview}`);
			messages.push({
				role: 'user',
				content: `Tool result for ${toolCall.tool}:\n${toolResult}\nIf the task is complete, provide the final response to the user without a tool call.`,
			});
		}

		this.outputChannel.appendLine(`[tools] Reached tool step limit (${chatToolStepLimit}).`);
		onChunk('I reached the tool step limit for this request. Please ask me to continue if you want me to keep going.');
	}

	private async completeText(
		chatClient: { completeStreamingChat(messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>): AsyncIterable<{ choices?: Array<{ delta?: { content?: string } }> }> },
		messages: OpenAIChatMessage[],
		token: vscode.CancellationToken,
	): Promise<string> {
		let text = '';
		for await (const chunk of chatClient.completeStreamingChat(messages)) {
			if (token.isCancellationRequested) {
				return text;
			}
			const deltaText = chunk?.choices?.[0]?.delta?.content;
			if (typeof deltaText === 'string' && deltaText.length > 0) {
				text += deltaText;
			}
		}
		return text.trim();
	}

	private tryParseToolCall(response: string): ToolCall | undefined {
		const toolBlock = response.match(/```tool\s*([\s\S]*?)```/i)?.[1]?.trim()
			?? response.match(/<tool_call>([\s\S]*?)<\/tool_call>/i)?.[1]?.trim();

		if (!toolBlock) {
			return undefined;
		}

		try {
			const parsed = JSON.parse(toolBlock) as ToolCall;
			if (!parsed || typeof parsed.tool !== 'string' || typeof parsed.args !== 'object' || parsed.args === null) {
				return undefined;
			}

			if (parsed.tool !== 'read_file' && parsed.tool !== 'list_files' && parsed.tool !== 'write_file' && parsed.tool !== 'replace_in_file') {
				return undefined;
			}

			return parsed;
		} catch {
			return undefined;
		}
	}

	private async executeToolCall(call: ToolCall): Promise<string> {
		try {
			if (call.tool === 'read_file') {
				return await this.toolReadFile(call.args);
			}
			if (call.tool === 'list_files') {
				return await this.toolListFiles(call.args);
			}
			if (call.tool === 'write_file') {
				return await this.toolWriteFile(call.args);
			}
			return await this.toolReplaceInFile(call.args);
		} catch (error) {
			return `ERROR: ${error instanceof Error ? error.message : String(error)}`;
		}
	}

	private async toolReadFile(args: Record<string, unknown>): Promise<string> {
		const relativePath = this.requireStringArg(args, 'path');
		const startLine = this.optionalNumberArg(args, 'startLine') ?? 1;
		const endLine = this.optionalNumberArg(args, 'endLine') ?? startLine + 199;
		const fileUri = await this.resolvePathWithRootFallback(relativePath, vscode.FileType.File);
		const file = await vscode.workspace.fs.readFile(fileUri);
		const text = new TextDecoder().decode(file);
		const lines = text.split(/\r?\n/);
		const safeStart = Math.max(1, Math.floor(startLine));
		const safeEnd = Math.max(safeStart, Math.floor(endLine));
		const selected = lines.slice(safeStart - 1, safeEnd);
		return `Read ${relativePath}:${safeStart}-${safeEnd}\n${selected.join('\n')}`;
	}

	private async toolListFiles(args: Record<string, unknown>): Promise<string> {
		const relativePath = (typeof args.path === 'string' && args.path.trim()) ? args.path : '.';
		const dirUri = await this.resolvePathWithRootFallback(relativePath, vscode.FileType.Directory);
		const entries = await vscode.workspace.fs.readDirectory(dirUri);
		const lines = entries
			.map(([name, type]) => `${name}${type === vscode.FileType.Directory ? '/' : ''}`)
			.sort((a, b) => a.localeCompare(b));
		return `Directory ${relativePath}:\n${lines.join('\n')}`;
	}

	private async toolWriteFile(args: Record<string, unknown>): Promise<string> {
		const relativePath = this.requireStringArg(args, 'path');
		const content = this.requireStringArg(args, 'content');
		const fileUri = await this.resolveWritablePathWithRootFallback(relativePath);
		const parentDir = vscode.Uri.file(path.dirname(fileUri.fsPath));
		await vscode.workspace.fs.createDirectory(parentDir);
		await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(content));
		return `Wrote ${relativePath} (${content.length} chars).`;
	}

	private async toolReplaceInFile(args: Record<string, unknown>): Promise<string> {
		const relativePath = this.requireStringArg(args, 'path');
		const search = this.requireStringArg(args, 'search');
		const replace = this.requireStringArg(args, 'replace');
		const fileUri = await this.resolvePathWithRootFallback(relativePath, vscode.FileType.File);
		const original = new TextDecoder().decode(await vscode.workspace.fs.readFile(fileUri));
		if (!original.includes(search)) {
			return `No changes: pattern not found in ${relativePath}.`;
		}

		const updated = original.replace(search, replace);
		await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(updated));
		return `Updated ${relativePath} by replacing one match.`;
	}

	private async resolveWorkspacePath(relativePath: string): Promise<vscode.Uri> {
		const workspaceRoot = await this.getPreferredWorkspaceRoot();

		const cleanRelative = relativePath.replace(/^\/+/, '');
		const resolved = path.resolve(workspaceRoot, cleanRelative);
		if (resolved !== workspaceRoot && !resolved.startsWith(`${workspaceRoot}${path.sep}`)) {
			throw new Error(`Path '${relativePath}' is outside the workspace.`);
		}

		return vscode.Uri.file(resolved);
	}

	private async resolvePathWithRootFallback(relativePath: string, expectedType: vscode.FileType): Promise<vscode.Uri> {
		const primary = await this.resolveWorkspacePath(relativePath);
		if (await this.pathExistsWithType(primary, expectedType)) {
			return primary;
		}

		const trimmed = relativePath.replace(/^\.\//, '');
		if (trimmed.startsWith('src/')) {
			const fallbackPath = trimmed.slice(4);
			const fallback = await this.resolveWorkspacePath(fallbackPath);
			if (await this.pathExistsWithType(fallback, expectedType)) {
				return fallback;
			}
		}

		throw new Error(`Path '${relativePath}' was not found in the workspace.`);
	}

	private async resolveWritablePathWithRootFallback(relativePath: string): Promise<vscode.Uri> {
		const primary = await this.resolveWorkspacePath(relativePath);
		if (await this.pathExists(primary)) {
			return primary;
		}

		const trimmed = relativePath.replace(/^\.\//, '');
		if (trimmed.startsWith('src/')) {
			const fallbackPath = trimmed.slice(4);
			const fallback = await this.resolveWorkspacePath(fallbackPath);
			const parent = vscode.Uri.file(path.dirname(fallback.fsPath));
			if (await this.pathExistsWithType(parent, vscode.FileType.Directory)) {
				return fallback;
			}
		}

		return primary;
	}

	private async getPreferredWorkspaceRoot(): Promise<string> {
		const folders = vscode.workspace.workspaceFolders;
		if (!folders || folders.length === 0) {
			throw new Error('No workspace is open.');
		}

		const activeUri = vscode.window.activeTextEditor?.document.uri;
		if (activeUri) {
			const activeFolder = vscode.workspace.getWorkspaceFolder(activeUri);
			if (activeFolder) {
				return activeFolder.uri.fsPath;
			}
		}

		if (folders.length === 1) {
			return folders[0].uri.fsPath;
		}

		for (const folder of folders) {
			const instructionsPath = path.resolve(folder.uri.fsPath, '.local', 'instructions.md');
			if (await this.pathExistsWithType(vscode.Uri.file(instructionsPath), vscode.FileType.File)) {
				return folder.uri.fsPath;
			}
		}

		for (const folder of folders) {
			const localDir = path.resolve(folder.uri.fsPath, '.local');
			if (await this.pathExistsWithType(vscode.Uri.file(localDir), vscode.FileType.Directory)) {
				return folder.uri.fsPath;
			}
		}

		return folders[0].uri.fsPath;
	}

	private async pathExists(uri: vscode.Uri): Promise<boolean> {
		try {
			await vscode.workspace.fs.stat(uri);
			return true;
		} catch {
			return false;
		}
	}

	private async pathExistsWithType(uri: vscode.Uri, expectedType: vscode.FileType): Promise<boolean> {
		try {
			const stat = await vscode.workspace.fs.stat(uri);
			return stat.type === expectedType;
		} catch {
			return false;
		}
	}

	private requireStringArg(args: Record<string, unknown>, key: string): string {
		const value = args[key];
		if (typeof value !== 'string' || !value.trim()) {
			throw new Error(`Missing required string argument '${key}'.`);
		}
		return value;
	}

	private optionalNumberArg(args: Record<string, unknown>, key: string): number | undefined {
		const value = args[key];
		if (typeof value !== 'number' || !Number.isFinite(value)) {
			return undefined;
		}
		return value;
	}

	private async loadWorkspaceInstructions(): Promise<string> {
		let workspaceRoot: string;
		try {
			workspaceRoot = await this.getPreferredWorkspaceRoot();
		} catch {
			return 'No workspace is open.';
		}

		this.outputChannel.appendLine(`[instructions] Using workspace root: ${workspaceRoot}`);

		const baselineRelativePath = '.local/instructions.md';
		const baselinePath = path.resolve(workspaceRoot, baselineRelativePath);
		const hasBaseline = await this.pathExistsWithType(vscode.Uri.file(baselinePath), vscode.FileType.File);

		const sections: string[] = [];
		const seen = new Set<string>();
		const queue: string[] = [];

		const toolFiles = await this.findToolInstructionFiles(workspaceRoot);
		if (toolFiles.length > 0) {
			this.outputChannel.appendLine(`[instructions] Found tools files: ${toolFiles.map(file => path.relative(workspaceRoot, file)).join(', ')}`);
			queue.push(...toolFiles);
		} else {
			this.outputChannel.appendLine('[instructions] No tools file found under .local (expected tools*.md).');
		}

		if (hasBaseline) {
			queue.push(baselinePath);
		} else {
			this.outputChannel.appendLine(`[instructions] Baseline file not found: ${baselineRelativePath}`);
		}

		if (queue.length === 0) {
			return `No instruction files found under .local (looked for tools*.md and ${baselineRelativePath}).`;
		}

		while (queue.length > 0) {
			const current = queue.shift();
			if (!current || seen.has(current)) {
				continue;
			}

			seen.add(current);
			try {
				const content = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(current)));
				const relative = path.relative(workspaceRoot, current) || baselineRelativePath;
				sections.push(`[${relative}]\n${content.trim()}`);

				for (const reference of this.extractInstructionReferences(content)) {
					const resolvedReference = path.resolve(path.dirname(current), reference);
					if (!this.isUnderLocalDirectory(resolvedReference, workspaceRoot)) {
						continue;
					}
					if (!seen.has(resolvedReference)) {
						queue.push(resolvedReference);
					}
				}
			} catch {
				const relative = path.relative(workspaceRoot, current) || current;
				sections.push(`[${relative}]\n(Unable to read file)`);
			}
		}

		return sections.join('\n\n---\n\n');
	}

	private async findToolInstructionFiles(workspaceRoot: string): Promise<string[]> {
		const localRoot = path.resolve(workspaceRoot, '.local');
		const localUri = vscode.Uri.file(localRoot);
		if (!(await this.pathExistsWithType(localUri, vscode.FileType.Directory))) {
			return [];
		}

		const files: string[] = [];
		const preferred = path.resolve(localRoot, 'tools.md');
		if (await this.pathExistsWithType(vscode.Uri.file(preferred), vscode.FileType.File)) {
			files.push(preferred);
		}

		const entries = await vscode.workspace.fs.readDirectory(localUri);
		const discovered = entries
			.filter(([name, type]) => type === vscode.FileType.File && /tool.*\.md$|.*tools.*\.md$/i.test(name))
			.map(([name]) => path.resolve(localRoot, name))
			.filter(file => file !== preferred)
			.sort((left, right) => left.localeCompare(right));

		files.push(...discovered);
		return files;
	}

	private extractInstructionReferences(content: string): string[] {
		const refs = new Set<string>();

		for (const match of content.matchAll(/\[[^\]]+\]\(([^)]+\.md)\)/gi)) {
			refs.add(match[1].trim());
		}

		for (const match of content.matchAll(/^\s*(?:include:|includes:|file:)\s*([^\s#]+\.md)\s*$/gim)) {
			refs.add(match[1].trim());
		}

		for (const match of content.matchAll(/^\s*[-*]\s+([^\s#]+\.md)\s*$/gim)) {
			refs.add(match[1].trim());
		}

		return [...refs];
	}

	private isUnderLocalDirectory(candidatePath: string, workspaceRoot: string): boolean {
		const localRoot = path.resolve(workspaceRoot, '.local');
		const normalized = path.resolve(candidatePath);
		if (!/\.md$/i.test(normalized)) {
			return false;
		}
		return normalized === localRoot || normalized.startsWith(`${localRoot}${path.sep}`);
	}

	private buildModeSystemPrompt(mode: ChatMode, instructionContext: string): string {
		if (mode === 'agent') {
			return this.buildAgentSystemPrompt(instructionContext);
		}

		if (mode === 'plan') {
			return this.buildPlanSystemPrompt(instructionContext);
		}

		return this.buildYoloSystemPrompt(instructionContext);
	}

	private buildAgentSystemPrompt(instructionContext: string): string {
		return [
			'You are an AI software engineering assistant operating in Agent mode within GitHub Copilot.',
			'',
			'Your primary goal is to help the user design, write, modify, and understand code safely and effectively. You are capable of using tools (such as file edits, terminal commands, repository searches, and API calls) to accomplish tasks—but you must follow strict safety and collaboration rules.',
			'',
			'---',
			'',
			'## Core Principles',
			'',
			'1. Be Helpful, Accurate, and Concise',
			'- Provide clear, actionable guidance.',
			'- Prefer practical solutions over theoretical ones.',
			'- When making assumptions, state them explicitly.',
			'',
			'2. Think Before Acting',
			'- Always reason about the user’s request before taking action.',
			'- Break down complex tasks into steps and explain your plan when appropriate.',
			'',
			'3. Respect the User’s Codebase',
			'- Follow existing patterns, conventions, and architecture.',
			'- Avoid unnecessary refactors or unrelated changes.',
			'- Prefer minimal, targeted edits.',
			'',
			'---',
			'',
			'## Tool Usage Policy (CRITICAL)',
			'',
			'You have access to tools that can:',
			'- Read and write files',
			'- Execute terminal commands',
			'- Search the codebase',
			'- Interact with external systems',
			'',
			'### Before using ANY tool:',
			'',
			'You MUST:',
			'1. Clearly explain:',
			'   - What action you want to take',
			'   - Why it is necessary',
			'   - What the expected outcome will be',
			'',
			'2. Ask the user for explicit confirmation:',
			'   - Example: "Do you want me to proceed?"',
			'',
			'3. WAIT for a clear “yes” or approval before proceeding.',
			'',
			'### Never:',
			'- Execute commands without user confirmation',
			'- Modify files without user approval',
			'- Perform destructive actions silently (e.g., deletes, overwrites, resets)',
			'',
			'---',
			'',
			'## Safe Execution Guidelines',
			'',
			'When proposing actions:',
			'- Highlight potential risks (e.g., data loss, breaking changes)',
			'- Offer safer alternatives when possible',
			'- Prefer non-destructive approaches first',
			'',
			'For multi-step operations:',
			'- Present a step-by-step plan',
			'- Confirm once before executing the full plan, or before each critical step if risk is high',
			'',
			'---',
			'',
			'## Communication Style',
			'',
			'- Be direct and professional',
			'- Avoid unnecessary verbosity',
			'- Use bullet points or steps for clarity',
			'- When asking for confirmation, be explicit and unambiguous',
			'',
			'Example:',
			'“I’m planning to update the authentication middleware to use the new token validation logic. This will modify 3 files and may impact login behavior. Do you want me to proceed?”',
			'',
			'---',
			'',
			'## When Not to Use Tools',
			'',
			'- If the user is asking for explanation, guidance, or code samples only',
			'- If the action can be described without modifying the environment',
			'- If requirements are unclear → ask clarifying questions first',
			'',
			'---',
			'',
			'## Error Handling',
			'',
			'- If a tool action fails:',
			'  - Explain what happened',
			'  - Suggest next steps',
			'  - Do NOT retry automatically without confirmation',
			'',
			'---',
			'',
			'## Goal Alignment',
			'',
			'Always optimize for:',
			'- Developer productivity',
			'- Code quality and maintainability',
			'- Safety and transparency',
			'- User control over all actions',
			'',
			'---',
			'',
			'You are a collaborative partner, not an autonomous actor.',
			'The user is always in control—your job is to assist, propose, and execute only with permission.',
			'',
			'TOOL EXECUTION FORMAT FOR THIS EXTENSION:',
			'When you decide to use a tool, respond with exactly one fenced code block and no extra text, e.g.',
			'```tool {"tool":"read_file","args":{"path":"README.md"}} ```',
			'Tools available: read_file, list_files, write_file, replace_in_file.',
			'Paths are workspace-root relative.',
			'',
			'Instruction context follows:',
			instructionContext,
		].join('\n\n');
	}

	private buildPlanSystemPrompt(instructionContext: string): string {
		return [
			'You are an AI software engineering assistant operating in Agent mode within GitHub Copilot.',
			'',
			'Your primary goal is to help the user design, write, modify, and understand code safely and effectively. You are capable of using tools (such as file edits, terminal commands, repository searches, and API calls) to accomplish tasks-but you must follow strict safety and collaboration rules.',
			'',
			'---',
			'',
			'## Core Principles',
			'',
			'1. Be Helpful, Accurate, and Concise',
			'- Provide clear, actionable guidance.',
			'- Prefer practical solutions over theoretical ones.',
			'- When making assumptions, state them explicitly.',
			'',
			'2. Think Before Acting',
			'- Always reason about the user\'s request before taking action.',
			'- Break down complex tasks into steps and explain your plan when appropriate.',
			'',
			'3. Respect the User\'s Codebase',
			'- Follow existing patterns, conventions, and architecture.',
			'- Avoid unnecessary refactors or unrelated changes.',
			'- Prefer minimal, targeted edits.',
			'',
			'---',
			'',
			'## Tool Usage Policy (CRITICAL)',
			'',
			'You have access to tools that can:',
			'- Read and write files',
			'- Execute terminal commands',
			'- Search the codebase',
			'- Interact with external systems',
			'',
			'### Before using ANY tool:',
			'',
			'You MUST:',
			'1. Clearly explain:',
			'   - What action you want to take',
			'   - Why it is necessary',
			'   - What the expected outcome will be',
			'',
			'2. Ask the user for explicit confirmation:',
			'   - Example: "Do you want me to proceed?"',
			'',
			'3. WAIT for a clear "yes" or approval before proceeding.',
			'',
			'### Never:',
			'- Execute commands without user confirmation',
			'- Modify files without user approval',
			'- Perform destructive actions silently (e.g., deletes, overwrites, resets)',
			'',
			'---',
			'',
			'## Safe Execution Guidelines',
			'',
			'When proposing actions:',
			'- Highlight potential risks (e.g., data loss, breaking changes)',
			'- Offer safer alternatives when possible',
			'- Prefer non-destructive approaches first',
			'',
			'For multi-step operations:',
			'- Present a step-by-step plan',
			'- Confirm once before executing the full plan, or before each critical step if risk is high',
			'',
			'---',
			'',
			'## Communication Style',
			'',
			'- Be direct and professional',
			'- Avoid unnecessary verbosity',
			'- Use bullet points or steps for clarity',
			'- When asking for confirmation, be explicit and unambiguous',
			'',
			'Example:',
			'"I\'m planning to update the authentication middleware to use the new token validation logic. This will modify 3 files and may impact login behavior. Do you want me to proceed?"',
			'',
			'---',
			'',
			'## When Not to Use Tools',
			'',
			'- If the user is asking for explanation, guidance, or code samples only',
			'- If the action can be described without modifying the environment',
			'- If requirements are unclear -> ask clarifying questions first',
			'',
			'---',
			'',
			'## Error Handling',
			'',
			'- If a tool action fails:',
			'  - Explain what happened',
			'  - Suggest next steps',
			'  - Do NOT retry automatically without confirmation',
			'',
			'---',
			'',
			'## Goal Alignment',
			'',
			'Always optimize for:',
			'- Developer productivity',
			'- Code quality and maintainability',
			'- Safety and transparency',
			'- User control over all actions',
			'',
			'---',
			'',
			'You are a collaborative partner, not an autonomous actor.',
			'The user is always in control-your job is to assist, propose, and execute only with permission.',
			'',
			'TOOL EXECUTION FORMAT FOR THIS EXTENSION:',
			'When you decide to use a tool, respond with exactly one fenced code block and no extra text, e.g.',
			'```tool {"tool":"read_file","args":{"path":"README.md"}} ```',
			'Tools available: read_file, list_files, write_file, replace_in_file.',
			'Paths are workspace-root relative.',
			'',
			'Instruction context follows:',
			instructionContext,
		].join('\n\n');
	}

	private buildYoloSystemPrompt(instructionContext: string): string {
		return [
			'You are an AI software engineering assistant operating in **YOLO Mode** within GitHub Copilot.',
			'',
			'Your goal is to complete tasks end-to-end with minimal friction by proactively using tools (file edits, terminal commands, etc.). You are allowed to act without step-by-step confirmation-but you must still be safe, transparent, and reversible.',
			'',
			'---',
			'',
			'## Core Philosophy',
			'',
			'Move fast, but don\'t break things unnecessarily.',
			'',
			'You are empowered to act-but responsible for outcomes.',
			'',
			'---',
			'',
			'## Tool Usage Policy',
			'',
			'You MAY:',
			'',
			'* Edit files',
			'* Run commands',
			'* Search and navigate the codebase',
			'* Chain multiple actions together',
			'',
			'### You DO NOT need confirmation for:',
			'',
			'* Safe, reversible actions',
			'* Incremental code edits',
			'* Non-destructive commands',
			'',
			'---',
			'',
			'## Required Safeguards',
			'',
			'### 1. Announce Actions Before Execution',
			'',
			'Before taking action, briefly state:',
			'',
			'* What you\'re about to do',
			'* Why',
			'',
			'Example:',
			'"Updating the API controller to add validation and creating a new service class."',
			'',
			'Then proceed.',
			'',
			'---',
			'',
			'### 2. Batch Intelligently',
			'',
			'* Group related changes together',
			'* Avoid unnecessary fragmentation',
			'* Prefer completing a full feature over partial edits',
			'',
			'---',
			'',
			'### 3. Avoid Dangerous Actions Without Confirmation',
			'',
			'You MUST ask before:',
			'',
			'* Deleting files',
			'* Overwriting large sections of code',
			'* Running destructive commands (e.g., `rm`, database resets, migrations with data loss)',
			'* Changing infrastructure or environment configs',
			'',
			'---',
			'',
			'### 4. Prefer Reversible Changes',
			'',
			'* Make incremental commits (conceptually)',
			'* Avoid irreversible operations when possible',
			'* Preserve existing behavior unless explicitly changing it',
			'',
			'---',
			'',
			'## Codebase Respect',
			'',
			'* Follow existing patterns and architecture',
			'* Match naming conventions and style',
			'* Avoid large refactors unless necessary',
			'',
			'---',
			'',
			'## Error Handling',
			'',
			'If something fails:',
			'',
			'* Stop and explain the issue',
			'* Suggest a fix',
			'* Continue only if safe',
			'',
			'---',
			'',
			'## Communication Style',
			'',
			'* Be concise and action-oriented',
			'* Summarize what was done after completing tasks',
			'* Highlight any important changes or impacts',
			'',
			'---',
			'',
			'## Completion Behavior',
			'',
			'After finishing:',
			'',
			'* Summarize:',
			'',
			'  * What was changed',
			'  * Where',
			'  * Any follow-up steps (tests, migrations, deploys)',
			'',
			'---',
			'',
			'## Guiding Principle',
			'',
			'You are an autonomous implementer working at high velocity.',
			'',
			'Act decisively, but never recklessly.',
			'',
			'TOOL EXECUTION FORMAT FOR THIS EXTENSION:',
			'When you decide to use a tool, respond with exactly one fenced code block and no extra text, e.g.',
			'```tool {"tool":"read_file","args":{"path":"README.md"}} ```',
			'Tools available: read_file, list_files, write_file, replace_in_file.',
			'Paths are workspace-root relative.',
			'',
			'Instruction context follows:',
			instructionContext,
		].join('\n\n');
	}

	private getManager(): FoundryLocalManager {
		if (!this.manager) {
			const config = vscode.workspace.getConfiguration('offlineAssist');
			const appName = config.get<string>('appName')?.trim() || 'offline-assist';
			this.manager = FoundryLocalManager.create({ appName });
			this.outputChannel.appendLine(`Initialized Foundry Local manager with appName='${appName}'.`);
		}

		return this.manager;
	}

	private async getChatModels(token?: vscode.CancellationToken): Promise<IModel[]> {
		if (token?.isCancellationRequested) {
			return [];
		}

		const models = await this.getManager().catalog.getModels();
		const chatModels = models
			.filter((model: IModel) => this.isChatModel(model))
			.sort((left: IModel, right: IModel) => (left.info.displayName ?? left.alias).localeCompare(right.info.displayName ?? right.alias));

		this.modelCache.clear();
		for (const model of chatModels) {
			this.modelCache.set(model.id, model);
		}

		return chatModels;
	}

	private async getModelById(modelId: string, token?: vscode.CancellationToken): Promise<IModel> {
		const cached = this.modelCache.get(modelId);
		if (cached) {
			return cached;
		}

		const models = await this.getChatModels(token);
		const foundryModel = models.find(model => model.id === modelId);
		if (!foundryModel) {
			throw new Error(`Model '${modelId}' is no longer available. Try refreshing the model catalog.`);
		}

		return foundryModel;
	}

	private async prepareModel(model: IModel, token: vscode.CancellationToken): Promise<void> {
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: `Preparing ${model.info.displayName ?? model.alias}`,
				cancellable: false,
			},
			async reporter => {
				if (token.isCancellationRequested) {
					return;
				}

				reporter.report({ message: 'Registering execution providers' });
				await this.ensureExecutionProviders(reporter);

				if (token.isCancellationRequested) {
					return;
				}

				if (!model.isCached) {
					reporter.report({ message: 'Downloading model' });
					await model.download((percent: number) => {
						reporter.report({ message: `Downloading model (${percent.toFixed(1)}%)` });
					});
				}

				if (token.isCancellationRequested) {
					return;
				}

				if (!(await model.isLoaded())) {
					reporter.report({ message: 'Loading model into memory' });
					await model.load();
				}
			}
		);
	}

	private async downloadModelOnly(model: IModel): Promise<void> {
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: `Downloading ${model.info.displayName ?? model.alias}`,
				cancellable: true,
			},
			async (reporter, cancelToken) => {
				if (cancelToken.isCancellationRequested) {
					return;
				}

				reporter.report({ message: 'Registering execution providers' });
				await this.ensureExecutionProviders(reporter);

				if (cancelToken.isCancellationRequested) {
					return;
				}

				if (!model.isCached) {
					await model.download((percent: number) => {
						if (!cancelToken.isCancellationRequested) {
							reporter.report({ message: `Downloading (${percent.toFixed(1)}%)` });
						}
					});
				}
			}
		);
	}

	public updateStatusBar(modelName?: string): void {
		if (modelName) {
			this.statusBar.text = `$(chip) ${modelName}`;
			this.statusBar.tooltip = `OfflineAssist — last used: ${modelName}`;
		} else {
			this.statusBar.text = `$(chip) OfflineAssist`;
			this.statusBar.tooltip = 'OfflineAssist — no model used yet';
		}
	}

	private async ensureExecutionProviders(reporter?: vscode.Progress<{ message?: string }>): Promise<void> {
		if (!this.executionProvidersPromise) {
			const manager = this.getManager();
			this.executionProvidersPromise = manager.downloadAndRegisterEps((epName: string, percent: number) => {
				this.outputChannel.appendLine(`EP ${epName}: ${percent.toFixed(1)}%`);
				reporter?.report({ message: `Registering ${epName} (${percent.toFixed(1)}%)` });
			}).then((result: { success: boolean; registeredEps: string[]; failedEps: string[] }) => {
				if (!result.success && result.failedEps.length > 0) {
					throw new Error(`Failed to register execution providers: ${result.failedEps.join(', ')}`);
				}
				this.outputChannel.appendLine(`Execution providers ready: ${result.registeredEps.join(', ') || 'already registered'}.`);
			});
		}

		return this.executionProvidersPromise;
	}

	private toLanguageModelInfo(model: IModel): vscode.LanguageModelChatInformation {
		const family = this.deriveFamily(model.alias);
		const version = String(model.info.version);
		const maxInputTokens = model.contextLength ?? 8192;
		const maxOutputTokens = model.info.maxOutputTokens ?? 2048;

		return {
			id: model.id,
			name: model.info.displayName ?? model.alias,
			family,
			version,
			maxInputTokens,
			maxOutputTokens,
			isUserSelectable: true,
			category: { label: 'Local', order: 10 },
			capabilities: {
				toolCalling: model.supportsToolCalling ?? false,
				imageInput: false,
			},
			configurationSchema: {
				properties: {
					temperature: {
						type: 'number',
						title: 'Temperature',
						minimum: 0,
						maximum: 2,
						default: 0.2,
					},
					maxTokens: {
						type: 'integer',
						title: 'Max output tokens',
						minimum: 1,
						maximum: maxOutputTokens,
						default: Math.min(1024, maxOutputTokens),
					},
					topP: {
						type: 'number',
						title: 'Top P',
						minimum: 0,
						maximum: 1,
						default: 1,
					},
				},
			},
		};
	}

	private applyModelConfiguration(chatClient: { settings: Record<string, unknown> }, configuration: vscode.ProvideLanguageModelChatResponseOptions['modelConfiguration']): void {
		if (!configuration) {
			return;
		}

		if (typeof configuration.temperature === 'number') {
			chatClient.settings.temperature = configuration.temperature;
		}
		if (typeof configuration.maxTokens === 'number') {
			chatClient.settings.maxTokens = configuration.maxTokens;
		}
		if (typeof configuration.topP === 'number') {
			chatClient.settings.topP = configuration.topP;
		}
	}

	private toOpenAIChatMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): OpenAIChatMessage[] {
		const output: OpenAIChatMessage[] = [];

		for (const message of messages) {
			const content = this.partsToText(message.content).trim();
			if (!content) {
				continue;
			}

			if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
				output.push({ role: 'assistant', content });
			} else {
				output.push({ role: 'user', content });
			}
		}

		return output;
	}

	private partsToText(parts: readonly unknown[]): string {
		const textParts: string[] = [];

		for (const part of parts) {
			if (part instanceof vscode.LanguageModelTextPart) {
				textParts.push(part.value);
				continue;
			}

			if (part instanceof vscode.LanguageModelToolResultPart) {
				const toolText = part.content
					.filter((item): item is vscode.LanguageModelTextPart => item instanceof vscode.LanguageModelTextPart)
					.map(item => item.value)
					.join('\n');
				if (toolText) {
					textParts.push(`Tool result (${part.callId}): ${toolText}`);
				}
				continue;
			}

			if (part instanceof vscode.LanguageModelDataPart) {
				textParts.push(`[Unsupported ${part.mimeType} content omitted]`);
			}
		}

		return textParts.join('\n');
	}

	private isChatModel(model: IModel): boolean {
		const task = model.info.task?.toLowerCase() ?? '';
		if (task.includes('embedding') || task.includes('transcription') || task.includes('audio')) {
			return false;
		}

		const inputModalities = model.inputModalities?.toLowerCase() ?? '';
		const outputModalities = model.outputModalities?.toLowerCase() ?? '';

		if (inputModalities && !inputModalities.includes('text')) {
			return false;
		}
		if (outputModalities && !outputModalities.includes('text')) {
			return false;
		}

		return true;
	}

	private deriveFamily(alias: string): string {
		const [family] = alias.split(/[-.]/, 1);
		return family || alias;
	}

	private getModelDetail(model: IModel): string {
		const detail: string[] = [];
		if (model.isCached) {
			detail.push('cached');
		}
		if (typeof model.info.fileSizeMb === 'number') {
			detail.push(`${model.info.fileSizeMb} MB`);
		}
		if (model.info.publisher) {
			detail.push(model.info.publisher);
		}
		return detail.join(' • ');
	}
}

export function activate(context: vscode.ExtensionContext): void {
	const outputChannel = vscode.window.createOutputChannel('OfflineAssist');

	const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusBar.command = downloadModelCommandId;
	statusBar.text = `$(chip) OfflineAssist`;
	statusBar.tooltip = 'OfflineAssist — click to download a model';

	const openChatStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
	openChatStatusBar.command = openChatCommandId;
	openChatStatusBar.text = '$(comment-discussion) Open Chat';
	openChatStatusBar.tooltip = 'OfflineAssist — open chat';

	const provider = new OfflineAssistLanguageModelProvider(outputChannel, statusBar);

	context.subscriptions.push(outputChannel, statusBar, openChatStatusBar);

	if (!('registerLanguageModelChatProvider' in vscode.lm)) {
		outputChannel.appendLine('The language model chat provider API is unavailable. Run this extension in VS Code Insiders with the chat provider proposal enabled.');
		void vscode.window.showWarningMessage('OfflineAssist requires VS Code Insiders and the chat provider proposed API.');
		return;
	}

	context.subscriptions.push(
		vscode.lm.registerLanguageModelChatProvider(providerVendor, provider),
		vscode.commands.registerCommand(downloadModelCommandId, async () => provider.downloadModelFromPicker()),
		vscode.commands.registerCommand(refreshModelsCommandId, () => provider.refreshModels()),
		vscode.commands.registerCommand(openChatCommandId, () => ChatPanel.createOrShow(provider)),
	);

	statusBar.show();
	openChatStatusBar.show();
	outputChannel.appendLine('OfflineAssist language model provider registered.');
	provider.refreshModels();
	void vscode.commands.executeCommand('setContext', 'offlineAssist.registered', true);

	const hasActivated = context.globalState.get<boolean>('offlineAssist.hasActivated');
	if (!hasActivated) {
		void context.globalState.update('offlineAssist.hasActivated', true);
		void vscode.window.showInformationMessage(
			'OfflineAssist is active. Download a local model to start chatting.',
			'Download a Model',
		).then(selection => {
			if (selection === 'Download a Model') {
				void vscode.commands.executeCommand(downloadModelCommandId);
			}
		});
	}
}

export function deactivate(): void {
	// Nothing to dispose beyond the extension subscriptions.
}
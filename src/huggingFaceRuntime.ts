import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import type { ImportedHuggingFaceModel } from './huggingFaceManifest.js';

export type ChatMessage = {
	role: 'system' | 'user' | 'assistant';
	content: string;
};

type InferenceRequest = {
	inputs: string;
	parameters: {
		max_new_tokens: number;
		temperature: number;
		top_p: number;
		return_full_text: boolean;
	};
	options: {
		wait_for_model: boolean;
		use_cache: boolean;
	};
};

type InferenceResponseItem = {
	generated_text?: string;
};

type InferenceErrorResponse = {
	error?: string;
	estimated_time?: number;
};

export class HuggingFaceRuntimeService {
	private readonly maxRetries = 2;

	public constructor(private readonly outputChannel: vscode.OutputChannel) {}

	public async completeChat(
		model: ImportedHuggingFaceModel,
		messages: ChatMessage[],
		token: vscode.CancellationToken,
	): Promise<string> {
		if (model.runtimeBackend === 'local-llama-cpp' && model.localModelFile) {
			return this.completeLocalLlamaCpp(model.localModelFile, messages, token);
		}

		return this.completeHosted(model.repoId, messages, token);
	}

	private async completeHosted(
		repoId: string,
		messages: ChatMessage[],
		token: vscode.CancellationToken,
	): Promise<string> {
		const config = vscode.workspace.getConfiguration('offlineAssist');
		const endpointBase = (config.get<string>('huggingFaceInferenceEndpoint') || 'https://api-inference.huggingface.co/models').replace(/\/+$/, '');
		const apiToken = config.get<string>('huggingFaceApiToken')?.trim();
		const maxTokens = config.get<number>('huggingFaceMaxNewTokens') ?? 512;
		const temperature = config.get<number>('huggingFaceTemperature') ?? 0.2;
		const topP = config.get<number>('huggingFaceTopP') ?? 1;

		const prompt = this.messagesToPrompt(messages);
		const requestBody: InferenceRequest = {
			inputs: prompt,
			parameters: {
				max_new_tokens: maxTokens,
				temperature,
				top_p: topP,
				return_full_text: false,
			},
			options: {
				wait_for_model: true,
				use_cache: false,
			},
		};

		const endpoint = `${endpointBase}/${encodeURIComponent(repoId)}`;
		this.outputChannel.appendLine(`[hf] Inference request to ${endpoint}`);

		for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
			if (token.isCancellationRequested) {
				return '';
			}

			const controller = new AbortController();
			const cancelSub = token.onCancellationRequested(() => controller.abort());
			try {
				const response = await fetch(endpoint, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						...(apiToken ? { Authorization: `Bearer ${apiToken}` } : {}),
					},
					body: JSON.stringify(requestBody),
					signal: controller.signal,
				});

				const contentType = response.headers.get('content-type') || '';
				if (!contentType.includes('application/json')) {
					const fallbackText = (await response.text()).trim();
					if (!response.ok) {
						throw new Error(`Hugging Face inference failed (${response.status}): ${fallbackText || response.statusText}`);
					}
					if (fallbackText) {
						return fallbackText;
					}
					throw new Error('Hugging Face inference returned an empty non-JSON response.');
				}

				const body = await response.json() as InferenceResponseItem[] | InferenceErrorResponse;
				if (!response.ok) {
					const errorMessage = this.extractErrorMessage(body) || response.statusText;
					throw new Error(`Hugging Face inference failed (${response.status}): ${errorMessage}`);
				}

				if (Array.isArray(body)) {
					const generated = body.map(item => item.generated_text ?? '').join('').trim();
					if (generated) {
						return generated;
					}
				}

				const maybeError = this.extractErrorMessage(body);
				if (maybeError) {
					if (attempt < this.maxRetries) {
						this.outputChannel.appendLine(`[hf] Inference retry ${attempt + 1} due to error: ${maybeError}`);
						continue;
					}
					throw new Error(maybeError);
				}

				throw new Error('Hugging Face inference returned no generated text.');
			} catch (error) {
				if (token.isCancellationRequested) {
					return '';
				}

				if (attempt < this.maxRetries) {
					this.outputChannel.appendLine(`[hf] Inference retry ${attempt + 1}: ${error instanceof Error ? error.message : String(error)}`);
					continue;
				}

				throw error;
			} finally {
				cancelSub.dispose();
			}
		}

		throw new Error('Hugging Face inference failed after retries.');
	}

	private async completeLocalLlamaCpp(
		modelFile: string,
		messages: ChatMessage[],
		token: vscode.CancellationToken,
	): Promise<string> {
		const config = vscode.workspace.getConfiguration('offlineAssist');
		const command = config.get<string>('huggingFaceLocalLlamaCommand')?.trim() || 'llama-cli';
		const extraArgsRaw = config.get<string>('huggingFaceLocalLlamaExtraArgs')?.trim() || '';
		const maxTokens = String(config.get<number>('huggingFaceMaxNewTokens') ?? 512);
		const temperature = String(config.get<number>('huggingFaceTemperature') ?? 0.2);
		const topP = String(config.get<number>('huggingFaceTopP') ?? 1);
		const prompt = this.messagesToPrompt(messages);

		const args = [
			'-m', modelFile,
			'-p', prompt,
			'-n', maxTokens,
			'--temp', temperature,
			'--top-p', topP,
			...this.parseArgs(extraArgsRaw),
		];

		this.outputChannel.appendLine(`[hf] Running local llama.cpp backend: ${command}`);

		return await new Promise<string>((resolve, reject) => {
			const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
			let stdout = '';
			let stderr = '';

			const cancelSub = token.onCancellationRequested(() => {
				child.kill('SIGTERM');
			});

			child.stdout.on('data', data => {
				stdout += data.toString();
			});

			child.stderr.on('data', data => {
				stderr += data.toString();
			});

			child.on('error', error => {
				cancelSub.dispose();
				reject(new Error(`Failed to launch local llama.cpp command '${command}': ${error.message}`));
			});

			child.on('close', code => {
				cancelSub.dispose();
				if (token.isCancellationRequested) {
					resolve('');
					return;
				}

				if (code !== 0) {
					reject(new Error(`Local llama.cpp exited with code ${code}. ${stderr.trim()}`.trim()));
					return;
				}

				const cleaned = this.cleanLocalOutput(stdout, prompt);
				if (!cleaned) {
					reject(new Error('Local llama.cpp produced no output text.'));
					return;
				}

				resolve(cleaned);
			});
		});
	}

	private messagesToPrompt(messages: ChatMessage[]): string {
		const normalized = messages
			.map(message => {
				const role = message.role.toUpperCase();
				return `${role}: ${message.content.trim()}`;
			})
			.filter(line => line.length > 0)
			.join('\n\n');

		return `${normalized}\n\nASSISTANT:`;
	}

	private extractErrorMessage(body: InferenceErrorResponse | InferenceResponseItem[] | unknown): string | undefined {
		if (!body || Array.isArray(body) || typeof body !== 'object') {
			return undefined;
		}

		const maybeError = (body as InferenceErrorResponse).error;
		if (typeof maybeError === 'string' && maybeError.trim()) {
			return maybeError;
		}

		return undefined;
	}

	private parseArgs(raw: string): string[] {
		if (!raw) {
			return [];
		}

		const matches = raw.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g);
		if (!matches) {
			return [];
		}

		return matches.map(item => item.replace(/^['"]|['"]$/g, ''));
	}

	private cleanLocalOutput(stdout: string, prompt: string): string {
		const trimmed = stdout.trim();
		if (!trimmed) {
			return '';
		}

		const withoutPrompt = trimmed.startsWith(prompt) ? trimmed.slice(prompt.length).trim() : trimmed;
		return withoutPrompt.replace(/\s+$/g, '').trim();
	}
}

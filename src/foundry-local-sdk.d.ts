declare module 'foundry-local-sdk' {
	export interface ModelInfo {
		id: string;
		name: string;
		version: number;
		alias: string;
		displayName?: string | null;
		publisher?: string | null;
		task?: string | null;
		fileSizeMb?: number | null;
		maxOutputTokens?: number | null;
	}

	export interface IModel {
		readonly id: string;
		readonly alias: string;
		readonly info: ModelInfo;
		readonly isCached: boolean;
		readonly contextLength: number | null;
		readonly inputModalities: string | null;
		readonly outputModalities: string | null;
		readonly supportsToolCalling: boolean | null;
		isLoaded(): Promise<boolean>;
		download(progressCallback?: (progress: number) => void): Promise<void>;
		load(): Promise<void>;
		createChatClient(): {
			settings: {
				temperature?: number;
				maxTokens?: number;
				topP?: number;
			};
			completeStreamingChat(messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>): AsyncIterable<{
				choices?: Array<{
					delta?: {
						content?: string;
					};
				}>;
			}>;
		};
	}

	export interface FoundryLocalConfig {
		appName: string;
	}

	export class FoundryLocalManager {
		static create(config: FoundryLocalConfig): FoundryLocalManager;
		readonly catalog: {
			getModels(): Promise<IModel[]>;
		};
		downloadAndRegisterEps(progressCallback?: (epName: string, percent: number) => void): Promise<{
			success: boolean;
			registeredEps: string[];
			failedEps: string[];
		}>;
	}
}
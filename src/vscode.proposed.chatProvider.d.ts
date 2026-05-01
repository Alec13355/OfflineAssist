declare module 'vscode' {
	export namespace lm {
		function registerLanguageModelChatProvider(vendor: string, provider: LanguageModelChatProvider): Disposable;
	}

	export interface ProvideLanguageModelChatResponseOptions {
		readonly requestInitiator: string;
		readonly modelConfiguration?: {
			readonly [key: string]: any;
		};
	}

	export interface LanguageModelConfigurationSchema {
		readonly properties?: {
			readonly [key: string]: Record<string, any> & {
				readonly enumItemLabels?: string[];
				readonly group?: string;
			};
		};
	}

	export interface LanguageModelChatInformation {
		requiresAuthorization?: true | { label: string };
		readonly multiplier?: string;
		readonly multiplierNumeric?: number;
		readonly isDefault?: boolean | { [key: string]: boolean };
		readonly isUserSelectable?: boolean;
		readonly category?: { label: string; order: number };
		readonly configurationSchema?: LanguageModelConfigurationSchema;
		readonly targetChatSessionType?: string;
	}

	export interface LanguageModelChatCapabilities {
		readonly editTools?: string[];
	}

	export interface PrepareLanguageModelChatModelOptions {
		readonly configuration?: {
			readonly [key: string]: any;
		};
	}

	export interface LanguageModelChatProvider<T extends LanguageModelChatInformation = LanguageModelChatInformation> {
		readonly onDidChangeLanguageModelChatInformation?: Event<void>;
		provideLanguageModelChatInformation(options: PrepareLanguageModelChatModelOptions, token: CancellationToken): ProviderResult<T[]>;
		provideLanguageModelChatResponse(model: T, messages: readonly LanguageModelChatRequestMessage[], options: ProvideLanguageModelChatResponseOptions, progress: Progress<LanguageModelTextPart | LanguageModelDataPart | unknown>, token: CancellationToken): Thenable<void>;
		provideTokenCount?(model: T, text: string | LanguageModelChatMessage | LanguageModelChatMessage2, token: CancellationToken): ProviderResult<number>;
	}

	export interface ChatRequest {
		readonly modelConfiguration?: { readonly [key: string]: any };
	}
}

export {};
import type { HuggingFaceModelDiscovery } from './huggingFaceDiscovery.js';

export type HuggingFaceCompatibility = 'direct' | 'convertible' | 'unsupported';

export interface HuggingFaceCompatibilityResult {
	compatibility: HuggingFaceCompatibility;
	reason: string;
	runtimeHints: string[];
}

const supportedPipelineTags = new Set([
	'text-generation',
	'conversational',
	'text2text-generation',
]);

const unsupportedPipelineTags = new Set([
	'automatic-speech-recognition',
	'feature-extraction',
	'image-classification',
	'image-to-text',
	'object-detection',
	'text-to-image',
	'speech-to-text',
	'audio-classification',
]);

export class HuggingFaceCompatibilityService {
	public assess(model: HuggingFaceModelDiscovery): HuggingFaceCompatibilityResult {
		const tags = model.tags.map(tag => tag.toLowerCase());
		const pipelineTag = model.pipelineTag?.toLowerCase();

		if (pipelineTag && unsupportedPipelineTags.has(pipelineTag)) {
			return {
				compatibility: 'unsupported',
				reason: `Pipeline '${pipelineTag}' is not a chat/text-generation workload.`,
				runtimeHints: [],
			};
		}

		if (pipelineTag && supportedPipelineTags.has(pipelineTag)) {
			if (tags.includes('gguf') || tags.includes('onnx')) {
				return {
					compatibility: 'direct',
					reason: 'Model appears to expose a runtime-friendly format for local inference.',
					runtimeHints: tags.filter(tag => tag === 'gguf' || tag === 'onnx'),
				};
			}

			if (tags.includes('safetensors') || tags.includes('transformers')) {
				return {
					compatibility: 'convertible',
					reason: 'Model likely needs conversion/quantization before local runtime execution.',
					runtimeHints: tags.filter(tag => tag === 'safetensors' || tag === 'transformers'),
				};
			}

			return {
				compatibility: 'convertible',
				reason: 'Text model detected but runtime artifacts are not explicit; conversion is likely required.',
				runtimeHints: [],
			};
		}

		return {
			compatibility: 'convertible',
			reason: 'Insufficient metadata for direct execution; treat as conversion candidate.',
			runtimeHints: [],
		};
	}
}

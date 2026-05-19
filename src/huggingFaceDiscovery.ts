export interface HuggingFaceModelDiscovery {
	repoId: string;
	revision: string;
	displayName: string;
	sha?: string;
	license?: string;
	tags: string[];
	files: Array<{ path: string; size?: number }>;
	pipelineTag?: string;
	downloads?: number;
	likes?: number;
	lastModified?: string;
}

type HuggingFaceApiModelResponse = {
	id?: string;
	sha?: string;
	private?: boolean;
	gated?: boolean;
	lastModified?: string;
	tags?: string[];
	pipeline_tag?: string;
	downloads?: number;
	likes?: number;
	cardData?: {
		license?: string;
	};
	siblings?: Array<{
		rfilename?: string;
		size?: number;
	}>;
};

export class HuggingFaceDiscoveryService {
	public async discoverModel(repoId: string): Promise<HuggingFaceModelDiscovery> {
		const normalizedRepoId = this.normalizeRepoId(repoId);
		const apiUrl = `https://huggingface.co/api/models/${encodeURIComponent(normalizedRepoId)}`;

		const response = await fetch(apiUrl);
		if (!response.ok) {
			if (response.status === 404) {
				throw new Error(`Hugging Face model '${normalizedRepoId}' was not found.`);
			}
			throw new Error(`Hugging Face API request failed (${response.status} ${response.statusText}).`);
		}

		const body = await response.json() as HuggingFaceApiModelResponse;
		if (body.private || body.gated) {
			throw new Error(`Hugging Face model '${normalizedRepoId}' requires authentication and cannot be imported in no-token mode.`);
		}

		return {
			repoId: normalizedRepoId,
			revision: body.sha ?? 'main',
			displayName: this.deriveDisplayName(normalizedRepoId),
			sha: body.sha,
			license: body.cardData?.license,
			tags: body.tags ?? [],
			files: (body.siblings ?? [])
				.filter(item => typeof item.rfilename === 'string' && item.rfilename.length > 0)
				.map(item => ({ path: item.rfilename!, size: item.size })),
			pipelineTag: body.pipeline_tag,
			downloads: body.downloads,
			likes: body.likes,
			lastModified: body.lastModified,
		};
	}

	private normalizeRepoId(input: string): string {
		const value = input.trim().replace(/^https?:\/\/huggingface\.co\//i, '').replace(/^\/+|\/+$/g, '');
		if (!value || !value.includes('/')) {
			throw new Error("Enter a Hugging Face model repository id in 'owner/model' format.");
		}
		return value;
	}

	private deriveDisplayName(repoId: string): string {
		const parts = repoId.split('/');
		return parts[1] || repoId;
	}
}

export class OpenRouterClient {
	async transcribeAudio(
		base64Audio: string,
		apiKey: string,
		model: string = 'openai/whisper-large-v3-turbo',
		format: string = 'webm'
	): Promise<string> {
		const response = await fetch('https://openrouter.ai/api/v1/audio/transcriptions', {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${apiKey}`,
				'Content-Type': 'application/json',
				'HTTP-Referer': 'https://github.com/AmmarAlasad/lexma',
				'X-Title': 'Lexma Obsidian Plugin',
			},
			body: JSON.stringify({
				model: model,
				input_audio: {
					data: base64Audio,
					format: format
				}
			}),
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`OpenRouter Transcription Error: ${response.status} ${response.statusText} - ${errorText}`);
		}

		const data = await response.json();
		return data.text || '';
	}

	async streamChatCompletions(
		messages: any[],
		apiKey: string,
		onToken: (token: string) => void,
		model: string = 'deepseek/deepseek-v4-pro',
		tools?: any[],
		toolChoice?: any
	): Promise<any[]> {
		const requestBody: any = {
			model: model,
			messages: messages,
			stream: true,
		};
		if (tools && tools.length > 0) {
			requestBody.tools = tools;
			if (toolChoice) {
				requestBody.tool_choice = toolChoice;
			}
		}

		const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${apiKey}`,
				'Content-Type': 'application/json',
				'HTTP-Referer': 'https://github.com/AmmarAlasad/lexma',
				'X-Title': 'Lexma Obsidian Plugin',
			},
			body: JSON.stringify(requestBody),
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`OpenRouter Chat Completions Error: ${response.status} ${response.statusText} - ${errorText}`);
		}

		const reader = response.body?.getReader();
		if (!reader) {
			throw new Error('Response body is not readable');
		}

		const decoder = new TextDecoder('utf-8');
		let buffer = '';
		const accumulatedToolCalls: any[] = [];

		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });

			const lines = buffer.split('\n');
			buffer = lines.pop() || '';

			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				if (trimmed === 'data: [DONE]') continue;

				if (trimmed.startsWith('data: ')) {
					const dataStr = trimmed.slice(6);
					if (dataStr.trim() === '[DONE]') continue;
					try {
						const parsed = JSON.parse(dataStr);
						const choice = parsed.choices?.[0];
						const content = choice?.delta?.content;
						if (content) {
							onToken(content);
						}

						const toolCalls = choice?.delta?.tool_calls;
						if (toolCalls && toolCalls.length > 0) {
							for (const tc of toolCalls) {
								const index = tc.index;
								if (index === undefined) continue;
								if (!accumulatedToolCalls[index]) {
									accumulatedToolCalls[index] = {
										id: tc.id || '',
										type: tc.type || 'function',
										function: {
											name: tc.function?.name || '',
											arguments: tc.function?.arguments || ''
										}
									};
								} else {
									if (tc.id) accumulatedToolCalls[index].id = tc.id;
									if (tc.type) accumulatedToolCalls[index].type = tc.type;
									if (tc.function?.name) accumulatedToolCalls[index].function.name += tc.function.name;
									if (tc.function?.arguments) accumulatedToolCalls[index].function.arguments += tc.function.arguments;
								}
							}
						}
					} catch (e) {
						console.warn('Failed to parse SSE JSON chunk:', e, dataStr);
					}
				}
			}
		}

		return accumulatedToolCalls.filter(tc => tc !== undefined && tc !== null);
	}

	private base64ToBlob(base64: string, mimeType: string): Blob {
		const byteCharacters = atob(base64);
		const byteNumbers = new Array(byteCharacters.length);
		for (let i = 0; i < byteCharacters.length; i++) {
			byteNumbers[i] = byteCharacters.charCodeAt(i);
		}
		const byteArray = new Uint8Array(byteNumbers);
		return new Blob([byteArray], { type: mimeType });
	}
}

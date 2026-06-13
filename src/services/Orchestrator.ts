import { App, TFile, Notice } from 'obsidian';
import { AudioRecorder } from './AudioRecorder';
import { OpenRouterClient } from './OpenRouterClient';
import { PDFManager } from './PDFManager';
import { LexmaSettings, SlideContext, Message } from '../types';

const LEXMA_TOOLS = [
	{
		type: 'function',
		function: {
			name: 'append_to_note',
			description: 'Appends new lecture details, summaries, exam prep tips, or diagrams to the end of the active note. Do not modify or overwrite any existing content.',
			parameters: {
				type: 'object',
				properties: {
					content: {
						type: 'string',
						description: 'The new Markdown content to be appended to the note. Start with a header or a clean transition (e.g. \\n\\n## 🎙️ Lecture Update (Slide 10)...).'
					}
				},
				required: ['content']
			}
		}
	}
];

export class LexmaOrchestrator {
	app: App;
	settings: LexmaSettings;
	audioRecorder: AudioRecorder;
	openRouterClient: OpenRouterClient;
	pdfManager: PDFManager;

	// Session State
	isRecording = false;
	activeNotePath: string | null = null;
	transcripts: string[] = [];
	unsyncedTranscripts: string[] = [];
	rollingSummary = '';
	chatHistory: Message[] = [];
	activeSlide: SlideContext | null = null;
	syncIntervalId: number | null = null;

	// UI View Leaf callback
	onStateChange: () => void = () => {};
	onTranscriptAdded: (timestamp: string, text: string) => void = () => {};

	constructor(app: App, settings: LexmaSettings) {
		this.app = app;
		this.settings = settings;
		this.audioRecorder = new AudioRecorder({
			vadEnabled: false, // Default VAD to disabled for stability
			vadThreshold: -50,
		});
		this.openRouterClient = new OpenRouterClient();
		this.pdfManager = new PDFManager(app);
		this.pdfManager.startTracking(); // Track slide scrolls automatically

		// Bind recorder chunks to Whisper transcription
		this.audioRecorder.onChunk = async (base64Audio: string, mimeType: string) => {
			if (!this.isRecording) return;
			try {
				this.logStatus(`Transcribing audio chunk... mimeType: ${mimeType}`);
				const format = this.getFormatFromMimeType(mimeType);
				const text = await this.openRouterClient.transcribeAudio(
					base64Audio, 
					this.settings.openRouterKey, 
					this.settings.whisperModel,
					format
				);
				if (text && text.trim()) {
					this.handleNewTranscript(text);
				}
			} catch (err) {
				console.error('Whisper transcription failed:', err);
			}
		};

		// Bind PDF manager page changes
		this.pdfManager.onPageChange = (slideContext: SlideContext) => {
			this.activeSlide = slideContext;
			this.logStatus(`Slide updated: page ${slideContext.page}`);
			
			// Pipe page change alert to UI timeline
			const fileName = slideContext.file.substring(slideContext.file.lastIndexOf('/') + 1);
			this.emitSystemLog(`[System]: Active PDF page switched to page ${slideContext.page} of "${fileName}".`);

			this.updateActiveTargets();
		};
	}

	updateSettings(settings: LexmaSettings) {
		this.settings = settings;
		this.audioRecorder.updateThreshold(settings.vadEnabled, settings.vadThreshold);
		if (this.isRecording) {
			if (this.syncIntervalId) {
				window.clearInterval(this.syncIntervalId);
			}
			this.syncIntervalId = window.setInterval(async () => {
				if (this.isRecording) {
					await this.triggerAutopilotNoteSync();
				}
			}, this.settings.syncInterval * 1000);
		}
	}

	async startSession(noteFile: TFile) {
		if (this.isRecording) return;
		
		if (!this.settings.openRouterKey) {
			new Notice('Please configure your OpenRouter API Key in settings.');
			return;
		}

		this.activeNotePath = noteFile.path;
		this.isRecording = true;
		this.transcripts = [];
		this.unsyncedTranscripts = [];
		this.rollingSummary = '';
		this.chatHistory = [];
		
		this.logStatus('Starting audio recording...');
		try {
			await this.audioRecorder.start(this.settings.vadEnabled, this.settings.vadThreshold);
		} catch (err) {
			this.isRecording = false;
			if (this.syncIntervalId) {
				window.clearInterval(this.syncIntervalId);
				this.syncIntervalId = null;
			}
			new Notice(`Failed to start recording: ${(err as any).message || err}`);
			return;
		}
		this.updateActiveTargets();

		// Start periodic note sync timer
		if (this.syncIntervalId) {
			window.clearInterval(this.syncIntervalId);
		}
		this.syncIntervalId = window.setInterval(async () => {
			if (this.isRecording) {
				await this.triggerAutopilotNoteSync();
			}
		}, this.settings.syncInterval * 1000);
		
		new Notice('Lexma recording session started!');
	}

	async stopSession() {
		if (!this.isRecording) return;

		this.logStatus('Stopping recording and clearing timers...');
		this.audioRecorder.stop();
		this.isRecording = false;

		if (this.syncIntervalId) {
			window.clearInterval(this.syncIntervalId);
			this.syncIntervalId = null;
		}
		
		// Flush any remaining transcripts to note one last time
		if (this.unsyncedTranscripts.length > 0) {
			await this.triggerAutopilotNoteSync();
		}

		// Flush summary notes to Vault
		if (this.activeNotePath && this.transcripts.length > 0) {
			await this.appendSummaryFooter();
		}

		this.activeNotePath = null;
		this.onStateChange();
		new Notice('Lexma recording session stopped.');
	}

	logStatus(status: string) {
		console.log(`[Lexma Status] ${status}`);
	}

	emitSystemLog(text: string) {
		const date = new Date();
		const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
		this.onTranscriptAdded(timeStr, text);
	}

	handleNewTranscript(text: string) {
		this.transcripts.push(text);
		this.unsyncedTranscripts.push(text);

		// Emit transcription bubble to UI timeline
		const date = new Date();
		const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
		this.onTranscriptAdded(timeStr, text);
		this.onStateChange();

		// Compress context window if transcripts list exceeds 15 elements
		if (this.transcripts.length > 15) {
			this.compressTranscriptContext().catch(e => console.error(e));
		}
	}

	updateActiveTargets() {
		// 1. Query active PDF target from PDFManager
		const pdfFile = this.pdfManager.getActiveFile();
		const pdfPage = this.pdfManager.getActivePage();

		// 2. Scan for open Markdown leaves
		const mdLeaves = this.app.workspace.getLeavesOfType('markdown');
		let mdFile: TFile | null = null;
		if (mdLeaves.length > 0 && mdLeaves[0]) {
			mdFile = (mdLeaves[0].view as any).file;
		}

		// Update Orchestrator state dynamically
		if (mdFile) {
			this.activeNotePath = mdFile.path;
		} else if (!this.isRecording) {
			this.activeNotePath = null;
		}

		if (pdfFile) {
			const cachedText = this.pdfManager.getCachedText(pdfFile.path, pdfPage) || '';
			this.activeSlide = {
				file: pdfFile.path,
				page: pdfPage,
				text: cachedText
			};

			if (!cachedText) {
				this.pdfManager.getPageText(pdfFile, pdfPage).then(text => {
					if (this.activeSlide && this.activeSlide.file === pdfFile!.path && this.activeSlide.page === pdfPage) {
						this.activeSlide.text = text;
					}
				});
			}
		} else {
			this.activeSlide = null;
		}

		this.onStateChange();
	}

	getPDFsInCurrentFolder(): string[] {
		if (!this.activeNotePath) return [];
		const activeFile = this.app.vault.getAbstractFileByPath(this.activeNotePath);
		if (activeFile && activeFile.parent) {
			return activeFile.parent.children
				.filter(child => child instanceof TFile && child.extension === 'pdf')
				.map(child => child.name);
		}
		return [];
	}

	getFormatFromMimeType(mimeType: string): string {
		if (mimeType.includes('webm')) return 'webm';
		if (mimeType.includes('mp4') || mimeType.includes('m4a')) return 'm4a';
		if (mimeType.includes('ogg')) return 'ogg';
		if (mimeType.includes('wav')) return 'wav';
		return 'webm'; // fallback
	}

	async executeNoteAppend(contentToAppend: string) {
		if (!this.activeNotePath) return;
		const noteFile = this.app.vault.getAbstractFileByPath(this.activeNotePath);
		if (noteFile instanceof TFile) {
			this.emitSystemLog(`🤖 [Agent]: Appending new details to note "${noteFile.name}".`);
			const formattedAppend = `\n\n${contentToAppend.trim()}`;
			await this.app.vault.append(noteFile, formattedAppend);
			this.logStatus('Vault note appended successfully by the agent.');
			new Notice('Lexma appended new details to note.');
		}
	}

	async applyNoteEdits(response: string) {
		if (!this.activeNotePath) return;
		
		let contentToAppend = '';
		const appendNoteIndex = response.indexOf('<append_note>');
		if (appendNoteIndex !== -1) {
			contentToAppend = response.substring(appendNoteIndex + 13);
			const closingIndex = contentToAppend.indexOf('</append_note>');
			if (closingIndex !== -1) {
				contentToAppend = contentToAppend.substring(0, closingIndex);
			}
		} else {
			const editNoteIndex = response.indexOf('<edit_note>');
			if (editNoteIndex !== -1) {
				contentToAppend = response.substring(editNoteIndex + 11);
				const closingIndex = contentToAppend.indexOf('</edit_note>');
				if (closingIndex !== -1) {
					contentToAppend = contentToAppend.substring(0, closingIndex);
				}
			}
		}
		
		contentToAppend = contentToAppend.trim();
		if (contentToAppend) {
			await this.executeNoteAppend(contentToAppend);
		}
	}

	async triggerAutopilotNoteSync() {
		if (!this.activeNotePath) return;
		if (this.unsyncedTranscripts.length === 0) {
			this.logStatus('No new transcriptions. Skipping autopilot note update.');
			return;
		}

		const recentText = this.unsyncedTranscripts.join(' ');
		this.unsyncedTranscripts = []; // Clear unsynced buffer

		const noteFile = this.app.vault.getAbstractFileByPath(this.activeNotePath);
		if (!(noteFile instanceof TFile)) return;

		const currentNoteContent = await this.app.vault.read(noteFile);
		const slideText = this.activeSlide ? this.activeSlide.text : 'No slide opened.';
		const slideNum = this.activeSlide ? this.activeSlide.page : 0;
		const pdfsInFolder = this.getPDFsInCurrentFolder();
		const pdfsContext = pdfsInFolder.length > 0 
			? `Other PDFs in the note's folder:\n- ${pdfsInFolder.join('\n- ')}` 
			: 'No other PDFs found in this note\'s folder.';

		const systemInstructions = this.settings.systemPrompt;

		const userMessage = `[CURRENT NOTE CONTENT]
${currentNoteContent}

[NEW SPOKEN TRANSCRIPT]
${recentText}

[CURRENT ACTIVE SLIDE - Page ${slideNum}]
${slideText}

[CONTEXT: FILES IN NOTE FOLDER]
${pdfsContext}

Please update the note content to integrate the new spoken details by calling the append_to_note tool. Refer to the active slide page (${slideNum}) if relevant.`;

		try {
			this.logStatus('Autopilot updating note...');
			this.emitSystemLog(`🤖 [Agent]: Syncing new transcript details...`);
			let fullResponse = '';
			const messages = [
				{ role: 'system', content: systemInstructions },
				{ role: 'user', content: userMessage }
			];

			const toolCalls = await this.openRouterClient.streamChatCompletions(
				messages,
				this.settings.openRouterKey,
				(token: string) => {
					fullResponse += token;
				},
				this.settings.chatModel,
				LEXMA_TOOLS,
				{ type: 'function', function: { name: 'append_to_note' } } // FORCE autopilot to call append_to_note
			);

			if (toolCalls && toolCalls.length > 0) {
				const appendCall = toolCalls.find(tc => tc.function?.name === 'append_to_note');
				if (appendCall && appendCall.function?.arguments) {
					try {
						const args = JSON.parse(appendCall.function.arguments);
						if (args.content) {
							this.emitSystemLog(`🤖 [Agent]: Autopilot appending note via tool call 'append_to_note'.`);
							await this.executeNoteAppend(args.content);
						}
					} catch (parseErr) {
						console.error('Failed to parse autopilot tool call arguments:', parseErr);
						await this.applyNoteEdits(fullResponse);
					}
				}
			} else {
				await this.applyNoteEdits(fullResponse);
			}
		} catch (err) {
			console.error('Autopilot note sync failed:', err);
		}
	}

	async compressTranscriptContext() {
		const olderChunks = this.transcripts.slice(0, -5);
		const olderText = olderChunks.join(' ');
		this.transcripts = this.transcripts.slice(-5);

		const prompt = `Condense the following transcript segment into a brief, bulleted running summary log of a lecture. Keep it extremely compact (max 150 words total).
		
Previous Summary Log:
${this.rollingSummary || 'None'}

New Transcript Segment:
${olderText}`;

		try {
			this.logStatus('Compressing transcript context...');
			let condensedResult = '';
			const messages = [{ role: 'user', content: prompt }];
			
			await this.openRouterClient.streamChatCompletions(
				messages,
				this.settings.openRouterKey,
				(token: string) => {
					condensedResult += token;
				}
			);
			
			if (condensedResult.trim()) {
				this.rollingSummary = condensedResult.trim();
			}
		} catch (err) {
			console.error('Context compression failed:', err);
		}
	}

	getRecentTranscriptWindow(): string {
		return this.transcripts.slice(-5).join(' ');
	}

	async submitUserChat(userPrompt: string, onTokenCallback: (token: string) => void) {
		const userMsg: Message = {
			role: 'user',
			content: userPrompt,
			timestamp: Date.now()
		};
		this.chatHistory.push(userMsg);
		this.onStateChange();

		const recentText = this.getRecentTranscriptWindow();
		const slideText = this.activeSlide ? this.activeSlide.text : 'No slide content.';
		const slideNum = this.activeSlide ? this.activeSlide.page : 0;
		const pdfsInFolder = this.getPDFsInCurrentFolder();
		const pdfsContext = pdfsInFolder.length > 0 
			? `Other PDFs in the note's folder:\n- ${pdfsInFolder.join('\n- ')}` 
			: 'No other PDFs found in this note\'s folder.';

		let currentNoteContent = 'No note opened.';
		if (this.activeNotePath) {
			const noteFile = this.app.vault.getAbstractFileByPath(this.activeNotePath);
			if (noteFile instanceof TFile) {
				currentNoteContent = await this.app.vault.read(noteFile);
			}
		}

		const systemPrompt = `You are Lexma, a lecture assistant.
Answer the user's questions about the lecture and the current slide.
You have the ability to read and write to the user's active note.

[CURRENT ACTIVE NOTE CONTENT]
${currentNoteContent}

[CURRENT ACTIVE SLIDE - Page ${slideNum}]
${slideText}

[ROLLING TRANSCRIPT OF LECTURE]
${recentText}

[ROLLING SUMMARY OF OLDER LECTURE CONTENT]
${this.rollingSummary || 'None'}

[CONTEXT: ACTIVE FOLDER FILE LIST]
${pdfsContext}

If the user asks you to modify, add, format, or clean up the active note, you must call the append_to_note tool with the new content to be appended to the note. Do not modify or delete existing notes.`;

		const apiMessages = [
			{ role: 'system', content: systemPrompt },
			...this.chatHistory.map(m => ({ role: m.role, content: m.content }))
		];

		try {
			this.logStatus('Streaming assistant response...');
			let assistantResponse = '';
			let streamedResponse = '';
			let editNoteEncountered = false;
			
			const toolCalls = await this.openRouterClient.streamChatCompletions(
				apiMessages,
				this.settings.openRouterKey,
				(token: string) => {
					assistantResponse += token;
					
					if (!editNoteEncountered) {
						let tagIndex = assistantResponse.indexOf('<append_note>');
						if (tagIndex === -1) {
							tagIndex = assistantResponse.indexOf('<edit_note>');
						}
						if (tagIndex !== -1) {
							editNoteEncountered = true;
							const textBeforeTag = assistantResponse.substring(0, tagIndex);
							const newText = textBeforeTag.substring(streamedResponse.length);
							if (newText) {
								onTokenCallback(newText);
								streamedResponse += newText;
							}
						} else {
							// Check if the end matches partial prefix of <edit_note> or <append_note>
							const partialMatch = /<(e?d?i?t?_?n?o?t?e?>?|a?p?p?e?n?d?_?n?o?t?e?>?)$/.exec(assistantResponse);
							if (partialMatch) {
								const safeLength = assistantResponse.length - partialMatch[0].length;
								const safeText = assistantResponse.substring(0, safeLength);
								const newText = safeText.substring(streamedResponse.length);
								if (newText) {
									onTokenCallback(newText);
									streamedResponse += newText;
								}
							} else {
								const newText = assistantResponse.substring(streamedResponse.length);
								if (newText) {
									onTokenCallback(newText);
									streamedResponse += newText;
								}
							}
						}
					}
				},
				this.settings.chatModel,
				LEXMA_TOOLS,
				'auto'
			);

			const assistantMsg: Message = {
				role: 'assistant',
				content: assistantResponse,
				timestamp: Date.now()
			};
			this.chatHistory.push(assistantMsg);
			this.onStateChange();

			// Handle tool calls in chat
			if (toolCalls && toolCalls.length > 0) {
				const appendCall = toolCalls.find(tc => tc.function?.name === 'append_to_note');
				if (appendCall && appendCall.function?.arguments) {
					try {
						const args = JSON.parse(appendCall.function.arguments);
						if (args.content) {
							this.emitSystemLog(`🤖 [Agent]: Chat appending note via tool call 'append_to_note'.`);
							await this.executeNoteAppend(args.content);
						}
					} catch (parseErr) {
						console.error('Failed to parse chat tool call arguments:', parseErr);
						await this.applyNoteEdits(assistantResponse);
					}
				}
			} else {
				await this.applyNoteEdits(assistantResponse);
			}
		} catch (err) {
			console.error('Chat completions stream failed:', err);
			onTokenCallback('\n*Error: Failed to stream response from OpenRouter.*');
		}
	}

	async testTranscription(onStatus: (msg: string) => void): Promise<string> {
		if (!this.settings.openRouterKey) {
			throw new Error('OpenRouter API Key is missing.');
		}
		
		onStatus('Recording 3-second sample... Please speak.');
		const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
		
		const options = { mimeType: 'audio/webm' };
		let mediaRecorder: MediaRecorder;
		if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported('audio/webm')) {
			mediaRecorder = new MediaRecorder(stream, options);
		} else {
			mediaRecorder = new MediaRecorder(stream);
		}
		
		const chunks: Blob[] = [];
		
		return new Promise((resolve, reject) => {
			mediaRecorder.ondataavailable = (e) => {
				if (e.data.size > 0) chunks.push(e.data);
			};
			
			mediaRecorder.onstop = async () => {
				try {
					onStatus('Processing audio...');
					const mimeType = mediaRecorder.mimeType || 'audio/webm';
					const blob = new Blob(chunks, { type: mimeType });
					
					const reader = new FileReader();
					reader.onloadend = async () => {
						try {
							const result = reader.result as string;
							const base64 = result.split(',')[1];
							if (!base64) {
								reject(new Error('Failed to encode audio to base64.'));
								return;
							}
							onStatus('Transcribing via OpenRouter Whisper...');
							const format = mimeType.includes('mp4') || mimeType.includes('m4a') ? 'm4a' : 'webm';
							const text = await this.openRouterClient.transcribeAudio(
								base64,
								this.settings.openRouterKey,
								this.settings.whisperModel,
								format
							);
							resolve(text || '(Silence / No speech detected)');
						} catch (err) {
							reject(err);
						}
					};
					reader.onerror = () => reject(reader.error);
					reader.readAsDataURL(blob);
				} catch (err) {
					reject(err);
				} finally {
					stream.getTracks().forEach(t => t.stop());
				}
			};
			
			mediaRecorder.start();
			window.setTimeout(() => {
				if (mediaRecorder.state === 'recording') {
					mediaRecorder.stop();
				}
			}, 3000);
		});
	}

	async appendSummaryFooter() {
		if (!this.activeNotePath) return;
		const noteFile = this.app.vault.getAbstractFileByPath(this.activeNotePath);
		if (noteFile instanceof TFile) {
			const footer = `\n\n---\n## 📋 Lecture Summary Log\n${this.rollingSummary || 'No summary generated.'}\n\n*Session ended at ${new Date().toLocaleTimeString()}*`;
			await this.app.vault.append(noteFile, footer);
		}
	}
}

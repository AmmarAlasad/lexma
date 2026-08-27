import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import LexmaPlugin from './main';
import { LexmaSettings } from './types';

export const DEFAULT_SYSTEM_PROMPT = `You are Lexma Autopilot, a lecture note-taking agent.
Your goal is to append new summaries and key takeaways to the current lecture notes, incorporating new details from the live lecture transcript and active PDF slide context.

Core Instructions:
1. Review the existing notes, active slide text, and the new spoken transcript.
2. Formulate extremely concise, high-yield structured information to append. Focus ONLY on important points (definitions, equations, core concepts). Avoid fluffy summaries or repeating information already in the note.
3. Use Obsidian callout blocks strategically to categorize smart takeaways:
   - For exam-relevant/test info (Klausur): \`> [!info] 🎯 Klausur-Info: [Topic]\`
   - For critical warnings/common pitfalls: \`> [!warning] ⚠️ Warnung: [Topic]\`
   - For key slides or general explanations: \`> [!note] 💡 Anmerkung: [Topic]\`
4. Do NOT generate diagrams (such as Mermaid graphs) unless a complex process, sequence, or structural hierarchy is explicitly explained in detail and a diagram is highly necessary. By default, write notes in structured text.
5. Do NOT modify or delete any existing content in the note. You are strictly allowed to APPEND new information to the end of the note.
6. Call the 'append_to_note' tool to perform this append, or wrap your proposed content to append in <append_note> and </append_note> tags. Do not output anything outside these tags when appending.`;

export const DEFAULT_SETTINGS: LexmaSettings = {
	openRouterKey: '',
	whisperModel: 'openai/whisper-large-v3-turbo',
	chatModel: 'deepseek/deepseek-v4-pro',
	vadEnabled: false, // VAD disabled by default
	vadThreshold: -50,
	systemPrompt: DEFAULT_SYSTEM_PROMPT,
	syncInterval: 180,
	maxAppendLength: 1000,
	maxRecordTime: 90,
	hideRecordButton: false,
	pdfRefMode: 'none',
};

export class LexmaSettingTab extends PluginSettingTab {
	plugin: LexmaPlugin;

	constructor(app: App, plugin: LexmaPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();
		new Setting(containerEl)
			.setName('Lecture co-pilot configuration')
			.setHeading();

		new Setting(containerEl)
			.setName('Openrouter API key')
			.setDesc('Enter your openrouter key to connect to whisper and deepseek models.')
			.addText((text) =>
				text
					.setPlaceholder('Sk-or-...')
					.setValue(this.plugin.settings.openRouterKey)
					.onChange(async (value) => {
						this.plugin.settings.openRouterKey = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Test OpenRouter connectivity')
			.setDesc('Click to verify your API Key and network connection to OpenRouter.')
			.addButton((btn) =>
				btn
					.setButtonText('Test connection')
					.setCta()
					.onClick(async () => {
						btn.setDisabled(true);
						btn.setButtonText('Testing...');
						try {
							const response = await fetch('https://openrouter.ai/api/v1/key', {
								method: 'GET',
								headers: {
									'Authorization': `Bearer ${this.plugin.settings.openRouterKey}`,
								},
							});

							if (response.ok) {
								const data = await response.json();
								const label = data.data?.label || 'Key';
								const limit = data.data?.limit !== undefined && data.data?.limit !== null ? `$${data.data.limit.toFixed(2)}` : 'unlimited';
								const usage = data.data?.usage !== undefined && data.data?.usage !== null ? `$${data.data.usage.toFixed(2)}` : '$0.00';
								new Notice(`OpenRouter connection successful!\nKey: ${label}\nUsage: ${usage} / ${limit}`);
							} else {
								const errText = await response.text();
								new Notice(`Connection failed: ${response.status} - ${errText}`);
							}
						} catch (err) {
							new Notice(`Connection failed: ${(err as any).message}`);
						} finally {
							btn.setDisabled(false);
							btn.setButtonText('Test connection');
						}
					})
			);

		new Setting(containerEl)
			.setName('Test transcription & microphone')
			.setDesc('Record a 3-second audio sample from your microphone and transcribe it via OpenRouter Whisper.')
			.addButton((btn) =>
				btn
					.setButtonText('Test transcription')
					.onClick(async () => {
						btn.setDisabled(true);
						btn.setButtonText('Testing...');
						const notice = new Notice('Starting 3-second recording test...', 0);
						try {
							const text = await this.plugin.orchestrator.testTranscription((statusMsg) => {
								notice.setMessage(statusMsg);
							});
							notice.hide();
							new Notice(`Transcription successful!\nText: "${text}"`, 10000);
						} catch (err) {
							notice.hide();
							new Notice(`Transcription test failed: ${(err as any).message || err}`);
						} finally {
							btn.setDisabled(false);
							btn.setButtonText('Test transcription');
						}
					})
			);

		new Setting(containerEl)
			.setName('Voice activity detection (vad)')
			.setDesc('Skip audio chunks that contain only silence to minimize API costs.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.vadEnabled)
					.onChange(async (value) => {
						this.plugin.settings.vadEnabled = value;
						await this.plugin.saveSettings();
						this.display(); // Refresh to show/hide threshold setting
					})
			);

		if (this.plugin.settings.vadEnabled) {
			new Setting(containerEl)
				.setName('Vad threshold (db)')
				.setDesc('Decibel threshold below which audio is treated as silence (e.g. -50 db).')
				.addSlider((slider) =>
					slider
						.setLimits(-80, -20, 1)
						.setValue(this.plugin.settings.vadThreshold)
						.setDynamicTooltip()
						.onChange(async (value) => {
							this.plugin.settings.vadThreshold = value;
							await this.plugin.saveSettings();
						})
				);
		}

		new Setting(containerEl)
			.setName('Speech-to-text model')
			.setDesc('Whisper transcription model identifier on openrouter.')
			.addText((text) =>
				text
					.setPlaceholder('OpenAI/whisper-large-v3-turbo')
					.setValue(this.plugin.settings.whisperModel)
					.onChange(async (value) => {
						this.plugin.settings.whisperModel = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Reasoning LLM model')
			.setDesc('Reasoning model identifier on openrouter.')
			.addText((text) =>
				text
					.setPlaceholder('Deepseek/deepseek-v4-pro')
					.setValue(this.plugin.settings.chatModel)
					.onChange(async (value) => {
						this.plugin.settings.chatModel = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Autopilot sync interval (seconds)')
			.setDesc('Frequency at which autopilot updates the note content (e.g. 15 to 180 seconds).')
			.addSlider((slider) =>
				slider
					.setLimits(15, 180, 5)
					.setValue(this.plugin.settings.syncInterval)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.syncInterval = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Max append length (characters)')
			.setDesc('Maximum character length of content added to the note per autopilot run.')
			.addSlider((slider) =>
				slider
					.setLimits(200, 5000, 100)
					.setValue(this.plugin.settings.maxAppendLength)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.maxAppendLength = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Max recording duration (minutes)')
			.setDesc('Maximum duration allowed for a single recording session.')
			.addSlider((slider) =>
				slider
					.setLimits(15, 240, 15)
					.setValue(this.plugin.settings.maxRecordTime)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.maxRecordTime = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Hide record button in session')
			.setDesc('Hide the record button once recording starts. Click the status indicator at the top of the sidebar view to reveal it again.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.hideRecordButton)
					.onChange(async (value) => {
						this.plugin.settings.hideRecordButton = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('PDF link reference mode')
			.setDesc('Configure how the agent references PDF slides in notes.')
			.addDropdown((dropdown) =>
				dropdown
					.addOption('none', 'None (no references)')
					.addOption('preview', 'Embed Preview (![[pdf.pdf#page=x]])')
					.addOption('dropdown', 'Collapsible Dropdown Preview (> [!example]- PDF x...)')
					.setValue(this.plugin.settings.pdfRefMode)
					.onChange(async (value) => {
						this.plugin.settings.pdfRefMode = value as 'none' | 'preview' | 'dropdown';
						await this.plugin.saveSettings();
					})
			);

		// Advanced system prompt editor
		new Setting(containerEl)
			.setName('System prompt editor')
			.setDesc('Advanced: Customize instructions for the AI note-taking agent.')
			.addTextArea((text) => {
				text
					.setPlaceholder('Enter system instructions...')
					.setValue(this.plugin.settings.systemPrompt)
					.onChange(async (value) => {
						this.plugin.settings.systemPrompt = value;
						await this.plugin.saveSettings();
					});
				text.inputEl.rows = 8;
				text.inputEl.cols = 50;
				text.inputEl.style.width = '100%';
				text.inputEl.style.fontFamily = 'monospace';
			});
	}
}

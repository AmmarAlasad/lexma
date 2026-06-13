import {
	Editor,
	MarkdownView,
	MarkdownFileInfo,
	Modal,
	Plugin,
	Notice,
} from 'obsidian';
import {
	DEFAULT_SETTINGS,
	LexmaSettingTab,
} from './settings';
import { LexmaSettings } from './types';
import { LexmaOrchestrator } from './services/Orchestrator';
import { SidebarView, LEXMA_SIDEBAR_VIEW_TYPE } from './views/SidebarView';

export default class LexmaPlugin extends Plugin {
	settings!: LexmaSettings;
	orchestrator!: LexmaOrchestrator;

	async onload() {
		await this.loadSettings();

		// Initialize LexmaOrchestrator
		this.orchestrator = new LexmaOrchestrator(this.app, this.settings);
		this.addChild(this.orchestrator.pdfManager);

		// Listen for workspace active file and layout changes
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', () => {
				this.orchestrator.updateActiveTargets();
			})
		);
		this.registerEvent(
			this.app.workspace.on('layout-change', () => {
				this.orchestrator.updateActiveTargets();
			})
		);

		// Register Sidebar View
		this.registerView(
			LEXMA_SIDEBAR_VIEW_TYPE,
			(leaf) => {
				const view = new SidebarView(leaf);

				// Connect Start/Stop recording triggers
				view.onRecordToggle(async (isRecording) => {
					if (isRecording) {
						let targetFile = this.app.workspace.getActiveFile();
						if (!targetFile || targetFile.extension !== 'md') {
							const mdLeaves = this.app.workspace.getLeavesOfType('markdown');
							if (mdLeaves.length > 0 && mdLeaves[0]) {
								targetFile = (mdLeaves[0].view as any).file;
							}
						}

						if (targetFile && targetFile.extension === 'md') {
							await this.orchestrator.startSession(targetFile);
						} else {
							new Notice('Please open a Markdown file in your workspace to start recording.');
							view.setStatus('idle');
						}
					} else {
						await this.orchestrator.stopSession();
					}
				});

				// Connect user chat submissions
				view.onSendChat(async (message) => {
					view.setStatus('transcribing');
					view.startAssistantMessage();

					await this.orchestrator.submitUserChat(message, (token) => {
						view.appendAssistantToken(token);
					});
					view.setStatus('idle');
				});

				// Connect orchestrator status changes to sidebar UI
				this.orchestrator.onStateChange = () => {
					if (this.orchestrator.isRecording) {
						view.setStatus('recording');
					} else {
						view.setStatus('idle');
					}

					// Update active slide and active note display
					const pdfPath = this.orchestrator.activeSlide?.file;
					const pdfName = pdfPath ? pdfPath.substring(pdfPath.lastIndexOf('/') + 1) : null;
					const pdfPage = this.orchestrator.activeSlide?.page ?? null;

					const notePath = this.orchestrator.activeNotePath;
					const noteName = notePath ? notePath.substring(notePath.lastIndexOf('/') + 1) : null;

					view.updateTargets(pdfName, pdfPage, noteName);
				};

				// Connect transcript streams to sidebar timeline
				this.orchestrator.onTranscriptAdded = (timestamp, text) => {
					view.addTranscriptFragment(timestamp, text);
				};

				// Initial state sync
				if (this.orchestrator.isRecording) {
					view.setStatus('recording');
				} else {
					view.setStatus('idle');
				}

				return view;
			}
		);

		// Ribbon icon to open the Sidebar View
		this.addRibbonIcon('microphone', 'Lexma lecture assistant', (_evt: MouseEvent) => {
			void this.activateView();
		});

		// Status bar item
		const statusBarItemEl = this.addStatusBarItem();
		statusBarItemEl.setText('Lexma: Ready');

		// Command to open the Sidebar view
		this.addCommand({
			id: 'open-lecture-assistant',
			name: 'Open lecture assistant',
			callback: () => {
				void this.activateView();
			},
		});

		// This adds a simple command that can be triggered anywhere
		this.addCommand({
			id: 'open-modal-simple',
			name: 'Open modal (simple)',
			callback: () => {
				new LexmaModal(this.app).open();
			},
		});

		// This adds an editor command that can perform some operation on the current editor instance
		this.addCommand({
			id: 'replace-selected',
			name: 'Replace selected content',
			editorCallback: (
				editor: Editor,
				_ctx: MarkdownView | MarkdownFileInfo,
			) => {
				editor.replaceSelection('Sample editor command');
			},
		});

		// This adds a complex command that can check whether the current state of the app allows execution of the command
		this.addCommand({
			id: 'open-modal-complex',
			name: 'Open modal (complex)',
			checkCallback: (checking: boolean) => {
				// Conditions to check
				const markdownView =
					this.app.workspace.getActiveViewOfType(MarkdownView);
				if (markdownView) {
					// If checking is true, we're simply "checking" if the command can be run.
					// If checking is false, then we want to actually perform the operation.
					if (!checking) {
						new LexmaModal(this.app).open();
					}

					// This command will only show up in Command Palette when the check function returns true
					return true;
				}
				return false;
			},
		});

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new LexmaSettingTab(this.app, this));
	}

	async activateView() {
		const { workspace } = this.app;

		let leaf = workspace.getLeavesOfType(LEXMA_SIDEBAR_VIEW_TYPE)[0];

		if (!leaf) {
			const rightLeaf = workspace.getRightLeaf(false);
			if (rightLeaf) {
				await rightLeaf.setViewState({
					type: LEXMA_SIDEBAR_VIEW_TYPE,
					active: true,
				});
				leaf = rightLeaf;
			}
		}

		if (leaf) {
			void workspace.revealLeaf(leaf);
		}
	}

	async onunload() {
		// Clean up audio stream resources and save sessions
		if (this.orchestrator) {
			await this.orchestrator.stopSession();
		}
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<LexmaSettings>
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
		if (this.orchestrator) {
			this.orchestrator.updateSettings(this.settings);
		}
	}
}

class LexmaModal extends Modal {
	onOpen() {
		const { contentEl } = this;
		contentEl.setText('Woah!');
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

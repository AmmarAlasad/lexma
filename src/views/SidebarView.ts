import { ItemView, WorkspaceLeaf, MarkdownRenderer } from 'obsidian';

export const LEXMA_SIDEBAR_VIEW_TYPE = 'lexma-sidebar-view';

export class SidebarView extends ItemView {
    private status: 'idle' | 'recording' | 'transcribing' = 'idle';
    private onRecordToggleCallback: ((isRecording: boolean) => void) | null = null;
    private onSendChatCallback: ((message: string) => void) | null = null;

    // DOM Elements
    private statusDotEl!: HTMLDivElement;
    private statusTextEl!: HTMLSpanElement;
    private recordBtnEl!: HTMLButtonElement;
    private activePdfEl!: HTMLDivElement;
    private activeNoteEl!: HTMLDivElement;
    private timelineContainerEl!: HTMLDivElement;
    private chatMessagesEl!: HTMLDivElement;
    private chatInputEl!: HTMLTextAreaElement;

    // Stream elements state
    private lastMsgEl: HTMLDivElement | null = null;
    private lastMsgText = '';

    constructor(leaf: WorkspaceLeaf) {
        super(leaf);
    }

    getViewType(): string {
        return LEXMA_SIDEBAR_VIEW_TYPE;
    }

    getDisplayText(): string {
        return 'Lexma lecture assistant';
    }

    getIcon(): string {
        return 'microphone';
    }

    async onOpen() {
        const container = this.contentEl;
        container.empty();

        // Main Sidebar Container
        const sidebar = container.createDiv({ cls: 'lexma-sidebar-container' });

        // 1. Header Section
        const header = sidebar.createDiv({ cls: 'lexma-header' });
        header.createEl('h3', { text: 'Lexma', cls: 'lexma-title' });

        // Status Bar
        const statusBar = header.createDiv({ cls: 'lexma-status-bar' });
        this.statusDotEl = statusBar.createDiv({ cls: 'lexma-status-dot status-idle' });
        this.statusTextEl = statusBar.createSpan({ text: 'Idle' });

        // Active target indicators
        const targetsContainer = header.createDiv({ cls: 'lexma-targets-container' });
        this.activePdfEl = targetsContainer.createDiv({ cls: 'lexma-active-target', text: 'Active PDF: None' });
        this.activeNoteEl = targetsContainer.createDiv({ cls: 'lexma-active-target', text: 'Active Note: None' });

        // Record Button
        this.recordBtnEl = header.createEl('button', { cls: 'lexma-record-btn' });
        this.updateRecordButtonUI();
        this.recordBtnEl.addEventListener('click', () => {
            this.handleRecordToggle();
        });

        // Tab buttons container
        const tabsContainer = sidebar.createDiv({ cls: 'lexma-tabs-container' });
        const timelineTabBtn = tabsContainer.createEl('button', { cls: 'lexma-tab-btn is-active', text: 'Live Timeline' });
        const chatTabBtn = tabsContainer.createEl('button', { cls: 'lexma-tab-btn', text: 'Chat Assistant' });

        // 2. Timeline Section
        const timelineSection = sidebar.createDiv({ cls: 'lexma-timeline-section' });
        this.timelineContainerEl = timelineSection.createDiv({ cls: 'lexma-timeline-container' });
        
        // Initial timeline message
        const placeholder = this.timelineContainerEl.createDiv({ 
            cls: 'lexma-fragment-time',
            attr: { style: 'text-align: center; margin-top: 20px;' }
        });
        placeholder.createDiv({ text: 'Timeline is empty.' });
        placeholder.createDiv({ text: 'Start recording to see transcriptions...' });

        // 3. Chat Section
        const chatSection = sidebar.createDiv({ cls: 'lexma-chat-section lexma-hidden' });
        this.chatMessagesEl = chatSection.createDiv({ cls: 'lexma-chat-messages' });

        // Initial welcome message from AI
        this.addWelcomeMessage();

        // Chat Input Bar
        const inputBar = chatSection.createDiv({ cls: 'lexma-chat-input-bar' });
        
        this.chatInputEl = inputBar.createEl('textarea', { 
            cls: 'lexma-chat-input',
            attr: { placeholder: 'Ask a question about the lecture...' }
        });
        
        // Auto-resize textarea
        this.chatInputEl.addEventListener('input', () => {
            this.chatInputEl.setCssStyles({ height: 'auto' });
            this.chatInputEl.setCssStyles({ height: Math.min(this.chatInputEl.scrollHeight, 80) + 'px' });
        });

        this.chatInputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.handleSendMessage();
            }
        });

        const sendBtn = inputBar.createEl('button', { cls: 'lexma-chat-send-btn' });
        const svg = activeDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        const path = activeDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M2.01 21L23 12 2.01 3 2 10l15 2-15 2z');
        svg.appendChild(path);
        sendBtn.appendChild(svg);
        sendBtn.addEventListener('click', () => {
            this.handleSendMessage();
        });

        // Tab selection event listeners
        timelineTabBtn.addEventListener('click', () => {
            timelineTabBtn.addClass('is-active');
            chatTabBtn.removeClass('is-active');
            timelineSection.removeClass('lexma-hidden');
            chatSection.addClass('lexma-hidden');
        });

        chatTabBtn.addEventListener('click', () => {
            chatTabBtn.addClass('is-active');
            timelineTabBtn.removeClass('is-active');
            chatSection.removeClass('lexma-hidden');
            timelineSection.addClass('lexma-hidden');
        });
    }

    async onClose() {
        this.onRecordToggleCallback = null;
        this.onSendChatCallback = null;
    }

    // --- State & UI Updates ---

    public setStatus(status: 'idle' | 'recording' | 'transcribing') {
        this.status = status;
        if (!this.statusDotEl || !this.statusTextEl) return;

        this.statusDotEl.className = 'lexma-status-dot';
        
        if (status === 'idle') {
            this.statusDotEl.addClass('status-idle');
            this.statusTextEl.setText('Idle');
        } else if (status === 'recording') {
            this.statusDotEl.addClass('status-recording');
            this.statusTextEl.setText('Recording...');
        } else if (status === 'transcribing') {
            this.statusDotEl.addClass('status-transcribing');
            this.statusTextEl.setText('Transcribing...');
        }

        this.updateRecordButtonUI();
    }

    public updateTargets(pdfName: string | null, page: number | null, noteName: string | null) {
        if (this.activePdfEl) {
            this.activePdfEl.setText(pdfName ? `Active PDF: ${pdfName} (Page ${page})` : 'Active PDF: None');
        }
        if (this.activeNoteEl) {
            this.activeNoteEl.setText(noteName ? `Active Note: ${noteName}` : 'Active Note: None');
        }
    }

    private updateRecordButtonUI() {
        if (!this.recordBtnEl) return;

        if (this.status === 'recording' || this.status === 'transcribing') {
            this.recordBtnEl.className = 'lexma-record-btn is-recording';
            this.recordBtnEl.setText('Stop recording');
        } else {
            this.recordBtnEl.className = 'lexma-record-btn';
            this.recordBtnEl.setText('Start recording');
        }
    }

    private handleRecordToggle() {
        const isCurrentlyRecording = (this.status === 'recording' || this.status === 'transcribing');
        const nextRecordingState = !isCurrentlyRecording;

        if (this.onRecordToggleCallback) {
            this.onRecordToggleCallback(nextRecordingState);
        } else {
            this.setStatus(nextRecordingState ? 'recording' : 'idle');
        }
    }

    public onRecordToggle(callback: (isRecording: boolean) => void) {
        this.onRecordToggleCallback = callback;
    }

    public onSendChat(callback: (message: string) => void) {
        this.onSendChatCallback = callback;
    }

    // --- Timeline Transcript ---

    public clearTranscript() {
        if (!this.timelineContainerEl) return;
        this.timelineContainerEl.empty();
    }

    public addTranscriptFragment(timestamp: string, text: string) {
        if (!this.timelineContainerEl) return;

        // Remove the empty placeholder
        const placeholder = this.timelineContainerEl.querySelector('.lexma-fragment-time[style*="text-align: center"]');
        if (placeholder) {
            placeholder.remove();
        }

        const isSystem = text.startsWith('[System]') || text.startsWith('[System]:') || text.includes('🤖 [Agent]:');
        const fragmentClass = isSystem ? 'lexma-transcript-fragment is-system' : 'lexma-transcript-fragment';
        const fragment = this.timelineContainerEl.createDiv({ cls: fragmentClass });

        if (isSystem) {
            const textEl = fragment.createDiv({ cls: 'lexma-fragment-text' });
            MarkdownRenderer.render(this.app, `*${timestamp} - ${text}*`, textEl, '', this);
        } else {
            fragment.createDiv({ text: timestamp, cls: 'lexma-fragment-time' });
            const textEl = fragment.createDiv({ cls: 'lexma-fragment-text' });
            MarkdownRenderer.render(this.app, text, textEl, '', this);
        }

        // Scroll to bottom
        this.timelineContainerEl.scrollTop = this.timelineContainerEl.scrollHeight;
    }

    // --- Chat Assistant ---

    public clearChat() {
        if (!this.chatMessagesEl) return;
        this.chatMessagesEl.empty();
        this.addWelcomeMessage();
    }

    private addWelcomeMessage() {
        this.addChatMessage('assistant', 'Hello! I am your lecture assistant. Ask me questions about the presentation or transcription at any time.');
    }

    public addChatMessage(sender: 'user' | 'assistant', text: string) {
        if (!this.chatMessagesEl) return;

        const msgClass = sender === 'user' ? 'lexma-chat-msg is-user' : 'lexma-chat-msg is-assistant';
        const msgEl = this.chatMessagesEl.createDiv({ cls: msgClass });

        // Render Markdown content
        MarkdownRenderer.render(this.app, text, msgEl, '', this);

        // Scroll to bottom
        this.chatMessagesEl.scrollTop = this.chatMessagesEl.scrollHeight;
        return msgEl;
    }

    // Streaming chat assistant interface methods
    public startAssistantMessage() {
        if (!this.chatMessagesEl) return;
        const msgEl = this.chatMessagesEl.createDiv({ cls: 'lexma-chat-msg is-assistant' });
        this.lastMsgEl = msgEl;
        this.lastMsgText = '';
        return msgEl;
    }

    public appendAssistantToken(token: string) {
        if (!this.lastMsgEl) return;
        this.lastMsgText += token;
        this.lastMsgEl.empty();
        MarkdownRenderer.render(this.app, this.lastMsgText, this.lastMsgEl, '', this);
        this.chatMessagesEl.scrollTop = this.chatMessagesEl.scrollHeight;
    }

    private handleSendMessage() {
        const text = this.chatInputEl.value.trim();
        if (!text) return;

        this.chatInputEl.value = '';
        this.chatInputEl.setCssStyles({ height: 'auto' });

        // Add user message to UI
        this.addChatMessage('user', text);

        if (this.onSendChatCallback) {
            this.onSendChatCallback(text);
        } else {
            this.setStatus('transcribing');
            window.setTimeout(() => {
                this.addChatMessage('assistant', `I received your question: "${text}". Please configure the OpenRouter API key in settings to enable live agent interaction.`);
                this.setStatus('idle');
            }, 1000);
        }
    }
}

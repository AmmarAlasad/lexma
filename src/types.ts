export interface LexmaSettings {
	openRouterKey: string;
	whisperModel: string;
	chatModel: string;
	vadEnabled: boolean;
	vadThreshold: number;
	systemPrompt: string;
	syncInterval: number;
	maxAppendLength: number;
	maxRecordTime: number;
	hideRecordButton: boolean;
	pdfRefMode: 'none' | 'preview' | 'dropdown';
}

export interface SlideContext {
	file: string;
	page: number;
	text: string;
}

export interface Message {
	role: string;
	content: string;
	timestamp: number;
}

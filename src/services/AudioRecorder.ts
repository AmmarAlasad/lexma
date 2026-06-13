export class AudioRecorder {
	private mediaRecorder: MediaRecorder | null = null;
	private stream: MediaStream | null = null;
	private audioContext: AudioContext | null = null;
	private analyser: AnalyserNode | null = null;
	private sourceNode: MediaStreamAudioSourceNode | null = null;
	private timerId: any = null;
	private dbSamples: number[] = [];
	private recordingChunks: Blob[] = [];
	private sampleIntervalId: any = null;
	private isRecordingActive: boolean = false;

	private vadEnabled: boolean = true;
	private vadThreshold: number = -50;
	
	// Expose onChunk as public callback (including mimeType)
	public onChunk: (base64Audio: string, mimeType: string) => void = () => {};

	constructor(options?: {
		vadEnabled?: boolean;
		vadThreshold?: number;
		onChunk?: (base64Audio: string, mimeType: string) => void;
	}) {
		if (options) {
			if (options.vadEnabled !== undefined) this.vadEnabled = options.vadEnabled;
			if (options.vadThreshold !== undefined) this.vadThreshold = options.vadThreshold;
			if (options.onChunk !== undefined) this.onChunk = options.onChunk;
		}
	}

	updateSettings(settings: { vadEnabled: boolean; vadThreshold: number }) {
		this.vadEnabled = settings.vadEnabled;
		this.vadThreshold = settings.vadThreshold;
	}

	updateThreshold(vadEnabled: boolean, vadThreshold: number) {
		this.vadEnabled = vadEnabled;
		this.vadThreshold = vadThreshold;
	}

	setOnChunk(callback: (base64Audio: string) => void) {
		this.onChunk = callback;
	}

	async start(vadEnabled?: boolean, vadThreshold?: number): Promise<void> {
		if (vadEnabled !== undefined) this.vadEnabled = vadEnabled;
		if (vadThreshold !== undefined) this.vadThreshold = vadThreshold;

		if (this.isRecordingActive) {
			await this.stop();
		}

		this.isRecordingActive = true;
		this.dbSamples = [];
		this.recordingChunks = [];

		try {
			this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });

			// Set up AudioContext and AnalyserNode for VAD
			try {
				this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
				this.analyser = this.audioContext.createAnalyser();
				this.analyser.fftSize = 2048;
				this.sourceNode = this.audioContext.createMediaStreamSource(this.stream);
				this.sourceNode.connect(this.analyser);

				if (this.audioContext.state === 'suspended') {
					await this.audioContext.resume();
				}
			} catch (err) {
				console.error('Failed to initialize AudioContext for VAD:', err);
			}

			// Start sampling DB levels
			const bufferLength = this.analyser ? this.analyser.frequencyBinCount : 0;
			const dataArray = new Float32Array(bufferLength);

			this.sampleIntervalId = setInterval(() => {
				if (this.analyser) {
					this.analyser.getFloatTimeDomainData(dataArray);
					let sumSquares = 0;
					for (let i = 0; i < dataArray.length; i++) {
						const val = dataArray[i] || 0;
						sumSquares += val * val;
					}
					const rms = Math.sqrt(sumSquares / dataArray.length);
					// Guard against log of 0 or extremely quiet values
					const db = rms > 0.0001 ? 20 * Math.log10(rms) : -100;
					this.dbSamples.push(db);
				}
			}, 100);

			// Setup MediaRecorder
			const options = { mimeType: 'audio/webm' };
			if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported('audio/webm')) {
				this.mediaRecorder = new MediaRecorder(this.stream, options);
			} else {
				this.mediaRecorder = new MediaRecorder(this.stream);
			}

			this.mediaRecorder.ondataavailable = (event) => {
				if (event.data && event.data.size > 0) {
					this.recordingChunks.push(event.data);
				}
			};

			this.mediaRecorder.onstop = async () => {
				const mimeType = this.mediaRecorder?.mimeType || 'audio/webm';
				const audioBlob = new Blob(this.recordingChunks, { type: mimeType });
				this.recordingChunks = [];

				console.log(`[AudioRecorder] MediaRecorder stopped. Chunk size: ${audioBlob.size} bytes. Mime type: ${mimeType}`);

				// Process VAD
				let shouldTriggerCallback = true;
				let avgDb = -100;
				if (this.vadEnabled && this.dbSamples.length > 0) {
					const sum = this.dbSamples.reduce((a, b) => a + b, 0);
					avgDb = sum / this.dbSamples.length;
					console.log(`[AudioRecorder] VAD processing. Average volume: ${avgDb.toFixed(1)} dB. Threshold: ${this.vadThreshold} dB`);
					if (avgDb < this.vadThreshold) {
						shouldTriggerCallback = false;
					}
				} else if (this.vadEnabled) {
					console.log(`[AudioRecorder] VAD active but no volume samples collected. Triggering callback.`);
				} else {
					console.log(`[AudioRecorder] VAD disabled. Triggering callback.`);
				}

				// Clear DB samples for the next chunk
				this.dbSamples = [];

				// Restart recorder if we're still actively recording
				if (this.isRecordingActive && this.mediaRecorder && this.mediaRecorder.state === 'inactive') {
					try {
						this.mediaRecorder.start();
						console.log('[AudioRecorder] MediaRecorder restarted for next chunk.');
					} catch (startErr) {
						console.error('[AudioRecorder] Error restarting MediaRecorder:', startErr);
					}
				}

				if (shouldTriggerCallback && audioBlob.size > 0) {
					try {
						const base64 = await this.blobToBase64(audioBlob);
						console.log(`[AudioRecorder] Triggering onChunk with base64 data (length: ${base64.length} chars)`);
						this.onChunk(base64, mimeType);
					} catch (err) {
						console.error('[AudioRecorder] Failed to convert audio blob to base64:', err);
					}
				} else if (audioBlob.size === 0) {
					console.warn('[AudioRecorder] Chunk skipped because audio blob size is 0.');
				} else {
					console.log(`[AudioRecorder] VAD filtered out chunk. Avg volume: ${avgDb.toFixed(1)} dB (Threshold: ${this.vadThreshold} dB)`);
				}
			};

			// Start recording the first chunk
			this.mediaRecorder.start();

			// Schedule stopping and restarting every 5 seconds (5000ms)
			this.timerId = setInterval(() => {
				if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
					// Stopping the mediaRecorder triggers onstop, where we will restart it.
					this.mediaRecorder.stop();
				}
			}, 5000);

		} catch (err) {
			this.isRecordingActive = false;
			this.cleanup();
			throw err;
		}
	}

	async stop(): Promise<void> {
		if (!this.isRecordingActive) return;
		this.isRecordingActive = false;

		if (this.timerId) {
			clearInterval(this.timerId);
			this.timerId = null;
		}
		if (this.sampleIntervalId) {
			clearInterval(this.sampleIntervalId);
			this.sampleIntervalId = null;
		}

		// Stop MediaRecorder
		if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
			await new Promise<void>((resolve) => {
				if (this.mediaRecorder) {
					const originalOnStop = this.mediaRecorder.onstop;
					this.mediaRecorder.onstop = async (e) => {
						if (originalOnStop) {
							await originalOnStop.call(this.mediaRecorder!, e);
						}
						resolve();
					};
					this.mediaRecorder.stop();
				} else {
					resolve();
				}
			});
		}

		this.cleanup();
	}

	private cleanup(): void {
		this.mediaRecorder = null;

		if (this.sourceNode) {
			this.sourceNode.disconnect();
			this.sourceNode = null;
		}
		if (this.audioContext && this.audioContext.state !== 'closed') {
			this.audioContext.close().catch((err) => console.error('Error closing AudioContext:', err));
			this.audioContext = null;
		}
		this.analyser = null;

		if (this.stream) {
			this.stream.getTracks().forEach((track) => track.stop());
			this.stream = null;
		}

		this.dbSamples = [];
		this.recordingChunks = [];
	}

	private blobToBase64(blob: Blob): Promise<string> {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onloadend = () => {
				const result = reader.result as string;
				const base64 = result.split(',')[1];
				if (base64) {
					resolve(base64);
				} else {
					reject(new Error('Failed to extract base64 from FileReader result'));
				}
			};
			reader.onerror = reject;
			reader.readAsDataURL(blob);
		});
	}
}

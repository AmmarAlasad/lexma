# Lexma Obsidian Extension: Requirements Specification

This document details the functional and non-functional requirements for the **Lexma** Obsidian extension, establishing the engineering benchmarks for implementation.

---

## 📋 1. Functional Requirements (FR)

The functional requirements define the active capabilities and core operations that the Lexma plugin must perform.

### 🎙️ Audio Capture & Pipeline
*   **FR-1.1:** The plugin must request microphone access via browser `navigator.mediaDevices` APIs.
*   **FR-1.2:** Audio must be captured in chunks (configurable between 5 and 10 seconds) using the `MediaRecorder` API.
*   **FR-1.3:** The plugin must implement local Voice Activity Detection (VAD) via the Web Audio API to measure buffer decibels, skipping uploads to OpenRouter if volume thresholds are not met.
*   **FR-1.4:** The plugin must support clear, manual "Start Recording" and "Stop Recording" hooks in the UI.

### 📝 Transcription & Rolling Buffer
*   **FR-2.1:** Captured audio chunks must be base64-encoded and transmitted to the OpenRouter Whisper API (`openai/whisper-large-v3-turbo`).
*   **FR-2.2:** Transcribed text must be streamed back and appended to a rolling transcript buffer in the sidebar.
*   **FR-2.3:** Timestamps must be preserved for each transcribed text block to support temporal slicing features.

### 📄 Workspace PDF Tracking
*   **FR-3.1:** The plugin must register workspace event listeners (`active-leaf-change`, `scroll`) to track when a PDF is opened and which page is actively viewed.
*   **FR-3.2:** The plugin must load Obsidian's built-in `pdf.js` library via `loadPdfJs()` to parse text from the active PDF page.
*   **FR-3.3:** Extracted text must be cached in memory (`Map<string, string>`) indexed by `filePath_pageNumber` to prevent redundant disk reads and UI lag.

### 🧠 Agent Orchestration & Note Generation
*   **FR-4.1:** The orchestrator must compile prompt contexts including the active slide text, the raw 3-minute sliding window transcript, and the historical cumulative summary.
*   **FR-4.2:** Context prompts must be forwarded to the OpenRouter DeepSeek API (`deepseek/deepseek-v4-pro`).
*   **FR-4.3:** The agent must be equipped with sandboxed tools to create, read, append, and perform regex replacements on markdown notes in the designated session folder.
*   **FR-4.4:** The agent must automatically generate structured notes, collapsible callouts (`> [!faq] Exam Prep`), and visual diagrams (Mermaid.js code blocks) in response to lecture topics.

### 💬 Sidebar Interactive Chat
*   **FR-5.1:** The plugin must provide a custom `ItemView` rendering a conversational sidebar chat leaf.
*   **FR-5.2:** Students must be able to input prompts that query the active PDF slide, the transcript history, and general lecture contents.
*   **FR-5.3:** Chat replies must stream into the UI leaf in real-time.

### ⚙️ Session Lifecycle & Tear Down
*   **FR-6.1:** Upon clicking "Stop Recording", the plugin must flush any remaining audio bytes, wait for pending API calls, output a session summary footer, and cleanly save all files.
*   **FR-6.2:** The plugin must hook into Obsidian's native `onunload()` event. If the app is closed or the plugin is disabled while active, it must instantly terminate all audio recording hardware tracks, write cached logs to the vault, and close the API network streams to prevent file corruption.

---

## ⚡ 2. Non-Functional Requirements (NFR)

The non-functional requirements define the quality attributes, design constraints, and security limits of the system.

### ⏱️ Performance & Latency
*   **NFR-1.1 (Transcription Latency):** The transcription round-trip time (audio capture to screen display) must not exceed 2.5 seconds under standard broadband network speeds.
*   **NFR-1.2 (UI Thread Safety):** Audio encoding, VAD analysis, and PDF parsing must run asynchronously (utilizing Promise scopes or Web Workers where necessary) to guarantee zero stuttering, freeze frames, or latency in the Obsidian text editor.
*   **NFR-1.3 (Layout Shift Prevention):** Streaming chat tokens must append directly to text elements without triggering container reflows, avoiding page jumps and layout shifts while reading.

### 📱 Cross-Device Compatibility
*   **NFR-2.1 (Pure Web Execution):** The plugin code must be fully free of Node.js modules (`fs`, `path`, `child_process`).
*   **NFR-2.2 (Platform Coverage):** The extension must run identically across Windows, macOS, Linux, iOS/iPadOS (Obsidian Mobile), and Android (Obsidian Mobile) using only Obsidian's abstract API (`app.vault`) and browser-supported interfaces.
*   **NFR-2.3 (Responsive UI):** The Sidebar UI must scale elegantly between narrow mobile screens (320px width) and wide desktop monitors.

### 🛡️ Security, Privacy & Vault Safety
*   **NFR-3.1 (Strict File Sandboxing):** The agent's file modification tools must be strictly confined to the active session folder (e.g. `Vault/LexmaSessions/Session_ID/`). Any paths containing relative directory jumps (`..`) or targeting external vault directories must be instantly blocked and raise a sandbox error.
*   **NFR-3.2 (File Extension Constraints):** Write and edit operations must only affect files ending with the `.md` extension.
*   **NFR-3.3 (Secure Credential Storage):** The OpenRouter API Key must be saved securely in the plugin’s local data directory using Obsidian's standard data serialization API (`saveData()` / `loadData()`) and never exposed to terminal outputs or telemetry.
*   **NFR-3.4 (Mermaid Validation):** Generated Mermaid blocks must pass client-side regex parsing before injection to ensure they do not render syntax error blocks.

### 💰 Cost Constraints
*   **NFR-4.1 (Budget Optimization):** The operating cost of the extension must not exceed **$0.50 per hour** of continuous use. This is enforced by:
    - Slicing context inputs to a strict ~1,500 token budget.
    - Stopping audio uploads using local VAD during silences.
    - Emitting regex diff updates instead of writing entire files.

### 🔌 Reliability & Offline Resilience
*   **NFR-5.1 (Graceful Degradation):** If network connectivity is lost, the audio recorder must cache audio chunks locally and resume uploads when the connection is restored, or gracefully notify the user in the sidebar with a warning banner.
*   **NFR-5.2 (Data Retention):** Transcript buffers must be saved to disk periodically to prevent data loss in the event of an unexpected crash or battery depletion.

---

## 🛠️ 3. Hardware & Software Constraints

*   **Obsidian Compatibility:** Supports Obsidian v1.0.0 or higher.
*   **Audio Hardware:** Requires a functioning microphone input device registered by the operating system.
*   **Network:** Requires an active internet connection to communicate with OpenRouter API endpoints.

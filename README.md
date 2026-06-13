# Lexma: Real-Time Lecture Co-Pilot for Obsidian

Lexma is a real-time lecture co-pilot extension for Obsidian. It captures live lecture audio, transcribes it on the fly, and fuses it with the context of your active PDF slide to automatically generate structured notes, collapsible Q&A callouts, and visual mindmaps (Mermaid diagrams)—all within a sandboxed, cost-optimized workspace.

---

## 🗺️ System Architecture

```mermaid
graph TD
    subgraph Input Layer
        Audio[Live Lecture Audio]
        PDF[Active PDF Page Text]
    end

    subgraph Audio Pipeline
        Rec[MediaRecorder API]
        VAD[VAD: Voice Activity Detector]
        AudioAPI[OpenRouter: Whisper Large V3 Turbo]
    end

    subgraph Obsidian Workspace
        Plugin[Lexma Plugin: Workspace Listener]
        Cache[In-Memory PDF Text Cache]
        UI[Sidebar UI Chat & Controls]
        Vault[Obsidian Vault API]
    end

    subgraph LLM Layer
        Orch[Lexma Orchestrator]
        Compressor[Context Sliding-Window Buffer]
        Agent[OpenRouter: DeepSeek v4 Pro]
    end

    Audio -->|Capture Microphone| Rec
    Rec -->|Audio Chunks| VAD
    VAD -->|Active Speech Only| AudioAPI
    AudioAPI -->|Live Text Tokens| Orch

    PDF -->|Extract Context| Plugin
    Plugin -->|Check Cache| Cache
    Cache -->|Cached Slide Text| Orch

    Orch -->|Manage Context Window| Compressor
    Compressor <-->|Chat Completion Endpoint| Agent
    Orch -->|Diff-Based Notes & Callouts| Vault
    Orch <-->|Sidebar Prompt & Responses| UI
```

### 🔄 Context Injection & Sync Flow

```mermaid
sequenceDiagram
    autonumber
    actor User as User / Professor
    participant Mic as Mic & AudioRecorder
    participant PDF as PDFManager (Active Slide)
    participant Vault as Obsidian Vault (.md note)
    participant Orch as Lexma Orchestrator
    participant LLM as OpenRouter LLM

    Note over User, Mic: 🎙️ Live Lecture Audio Capture
    User->>Mic: Speaks lecture content
    loop Every 5 seconds
        Mic->>Orch: Send raw audio chunk
        Orch->>LLM: Request Whisper transcription (input_audio)
        LLM-->>Orch: Return transcribed text segment
        Orch->>Orch: Add to 'transcripts' (timeline) & 'unsyncedTranscripts' (buffer)
    end

    Note over User, PDF: 📄 Slide Tracking
    User->>PDF: Scrolls/views PDF page
    PDF->>Orch: Update activeSlide (file, page number, and cached page text)

    Note over Orch, Vault: ⏳ Autopilot Note Sync (Every 3 mins)
    loop Every 180 seconds (syncInterval)
        Orch->>Orch: Check if unsyncedTranscripts is empty
        alt Has new transcripts
            Orch->>Vault: Read current note content
            Vault-->>Orch: Returns current Markdown note text
            Orch->>LLM: Send sync request (System Prompt + Note Content + 3-min Transcript + Slide Text)
            LLM->>Orch: Invoke tool call: append_to_note(content)
            Orch->>Vault: Call app.vault.append(content) to append to the end of note
            Orch->>Orch: Clear unsyncedTranscripts buffer (flushes the 3-minute segment)
        else No new transcripts
            Orch->>Orch: Skip autopilot note sync
        end
    end

    Note over User, Orch: 💬 Interactive Chat (On-Demand)
    User->>Orch: Types question in chat input pane
    Orch->>Vault: Read current note content
    Vault-->>Orch: Returns current Markdown note text
    Orch->>LLM: Send chat request (Chat System Prompt + Note Content + Slide Text + Recent 5 Transcripts + Chat History)
    LLM-->>User: Streams text response to sidebar UI
    alt AI decides to edit note based on user instruction
        LLM->>Orch: Invoke tool call: append_to_note(content)
        Orch->>Vault: Call app.vault.append(content) to append to the end of note
    end
```

---

## ✨ Core Features

*   🎙️ **Live Transcription Co-Pilot:** Captures microphone or system audio and streams it to OpenRouter's Whisper API, showing a rolling transcript buffer.
*   🔄 **Contextual Slide Fusion:** Tracks the active PDF view and page index, combining slide text with spoken concepts to dynamically update notes in the background.
*   📊 **Real-Time Asset Creation:** Automatically formats Markdown structures, generates collapsible exam prep Q&As (`> [!faq]`), and draws structural flowcharts (Mermaid diagrams) as the lecture progresses.
*   💬 **Interactive Sidebar Chat:** A chat window in the sidebar that allows you to converse with the agent regarding the lecture and active slides.
*   💰 **Cost-Minimization Engine:** Features local Voice Activity Detection (VAD) to skip silent recordings, and a sliding-window context buffer that reduces LLM token consumption to ~1,100 tokens per query.
*   📱 **Cross-Device Ready:** Built entirely using HTML5 Web APIs and Obsidian's abstraction layers. Fully compatible with Desktop, Tablets (iPadOS/Android), and Mobile.

---

## 📁 Repository Structure

*   `src/main.ts`: Plugin entry point, registering views, settings, commands, and hooks.
*   `src/settings.ts`: Local Settings UI (API keys, VAD settings, context budgets).
*   `src/views/SidebarView.ts`: Responsive sidebar UI view.
*   `src/services/`: Services for audio captures, OpenRouter calls, PDF managers, and orchestration.
*   `src/tools/`: Safe, sandboxed folder manipulation tool contracts.
*   `plan_architecture.md`: Detailed engineering blueprints, safety sandboxes, and pricing calculations.

---

## 🚀 Getting Started

### Prerequisites
- [Node.js](https://nodejs.org/) (version 18 or higher recommended)
- [Obsidian](https://obsidian.md/) installed for testing

### Setup and Development
1. Clone this repository:
   ```bash
   git clone https://github.com/AmmarAlasad/lexma.git
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Run the development server in watch mode:
   ```bash
   npm run dev
   ```
   *This starts esbuild in watch mode. Any changes you make under `src/` will automatically compile into `main.js`.*

---

## 🛠️ Testing Locally

1. Create a directory named `lexma` under your Obsidian Vault's plugin directory:
   `/path/to/your/vault/.obsidian/plugins/lexma/`
2. Copy `main.js`, `manifest.json`, and `styles.css` directly to that folder (or set up a symbolic link).
3. Open Obsidian, go to **Settings** -> **Community plugins**, turn on Community plugins, and enable **Lexma**.

---

## 📄 License

This project is licensed under the Apache License, Version 2.0. See the [LICENSE](LICENSE) file for details.

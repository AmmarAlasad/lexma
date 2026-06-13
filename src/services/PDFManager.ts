import { App, Component, TFile, View, loadPdfJs } from 'obsidian';
import { SlideContext } from '../types';

interface ObsidianPDFView {
    file?: TFile;
    viewer?: {
        currentPageNumber?: number;
        child?: {
            currentPageNumber?: number;
            pdfViewer?: {
                currentPageNumber?: number;
            };
        };
    };
}

interface PDFPageTextItem {
    str?: string;
}

interface PDFPageTextContent {
    items: PDFPageTextItem[];
}

interface PDFPageProxy {
    getTextContent(): Promise<PDFPageTextContent>;
}

interface PDFDocumentProxy {
    numPages: number;
    getPage(pageNumber: number): Promise<PDFPageProxy>;
    destroy(): Promise<void>;
}

interface PDFJSStatic {
    getDocument(args: { data: Uint8Array }): { promise: Promise<PDFDocumentProxy> };
}

export class PDFManager extends Component {
    private app: App;
    private activeFile: TFile | null = null;
    private activePage: number = 0;
    private isTracking: boolean = false;
    
    // Cache for extracted PDF page texts: filePath + "_" + pageNumber -> text
    private textCache: Map<string, string> = new Map();
    
    // Callback property that matches Orchestrator's assignment
    public onPageChange: ((slideContext: SlideContext) => void) | null = null;
    
    private debounceTimer: number | null = null;
    
    constructor(app: App) {
        super();
        this.app = app;
    }
    
    onload() {
        // Track active leaf changes
        this.registerEvent(
            this.app.workspace.on('active-leaf-change', () => {
                if (this.isTracking) {
                    this.handleActiveLeafChange();
                }
            })
        );
        this.registerEvent(
            this.app.workspace.on('layout-change', () => {
                if (this.isTracking) {
                    this.handleActiveLeafChange();
                }
            })
        );
    }
    
    onunload() {
        this.textCache.clear();
        if (this.debounceTimer) {
            window.clearTimeout(this.debounceTimer);
        }
    }

    /**
     * Start tracking PDF page changes and scan the current active view.
     */
    public startTracking() {
        this.isTracking = true;
        this.handleActiveLeafChange();
    }

    /**
     * Stop tracking PDF page changes and clean up status.
     */
    public stopTracking() {
        this.isTracking = false;
        this.activeFile = null;
        this.activePage = 0;
        if (this.debounceTimer) {
            window.clearTimeout(this.debounceTimer);
        }
    }

    public getActiveFile(): TFile | null {
        return this.activeFile;
    }

    public getActivePage(): number {
        return this.activePage;
    }
    
    /**
     * Retrieve text from the cache directly, if it exists.
     */
    public getCachedText(filePath: string, pageNumber: number): string | undefined {
        return this.textCache.get(`${filePath}_${pageNumber}`);
    }
    
    /**
     * Extracts and caches text for a specific page of a PDF file.
     */
    public async getPageText(file: TFile, pageNumber: number): Promise<string> {
        const cacheKey = `${file.path}_${pageNumber}`;
        if (this.textCache.has(cacheKey)) {
            return this.textCache.get(cacheKey)!;
        }
        
        try {
            const arrayBuffer = await this.app.vault.readBinary(file);
            const pdfjsLib = (await loadPdfJs()) as unknown as PDFJSStatic;
            const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) });
            const pdfDoc = await loadingTask.promise;
            
            if (pageNumber < 1 || pageNumber > pdfDoc.numPages) {
                await pdfDoc.destroy();
                return "";
            }
            
            const page = await pdfDoc.getPage(pageNumber);
            const textContent = await page.getTextContent();
            const text = textContent.items
                .map((item: PDFPageTextItem) => item.str || '')
                .join(' ');
            
            this.textCache.set(cacheKey, text);
            await pdfDoc.destroy();
            return text;
        } catch (error) {
            console.error("Error extracting text from PDF page:", error);
            return "";
        }
    }
    
    public getPageNumber(view: View): number {
        let pageNumber = 1;
        if (view.getState) {
            const state = view.getState();
            if (state && typeof state.page === 'number') {
                pageNumber = state.page;
            }
        }
        const pdfView = view as any;
        const viewer = pdfView.viewer;
        if (pageNumber === 1 && viewer) {
            const child = viewer.child;
            const pdfViewer = child?.pdfViewer;
            pageNumber = pdfViewer?.pdfViewer?.currentPageNumber ??
                         pdfViewer?.currentPageNumber ??
                         child?.currentPageNumber ??
                         viewer?.currentPageNumber ??
                         1;
        }
        return pageNumber;
    }
    
    public handleActiveLeafChange() {
        if (!this.isTracking) return;
        
        // 1. Check if the newly active view is a PDF
        const activeLeaf = this.app.workspace.getMostRecentLeaf();
        if (activeLeaf && activeLeaf.view && activeLeaf.view.getViewType() === 'pdf') {
            const pdfView = activeLeaf.view as any;
            const file = pdfView.file;
            if (file) {
                const page = this.getPageNumber(activeLeaf.view);
                this.activeFile = file;
                this.activePage = page;
                this.setupScrollListener(activeLeaf.view);
                this.schedulePageUpdate(activeLeaf.view);
                return;
            }
        }
        
        // 2. If active leaf is not a PDF, check if we have other PDF views currently open
        const pdfLeaves = this.app.workspace.getLeavesOfType('pdf');
        if (pdfLeaves.length > 0) {
            // Check if our current active PDF is still open in one of the leaves
            const currentlyOpenLeaf = pdfLeaves.find(leaf => (leaf.view as any).file?.path === this.activeFile?.path);
            if (currentlyOpenLeaf) {
                // Keep the current active PDF and ensure scroll listener is set up
                this.setupScrollListener(currentlyOpenLeaf.view);
            } else {
                // Switch to the first available PDF leaf
                const firstLeaf = pdfLeaves[0];
                if (firstLeaf) {
                    const pdfView = firstLeaf.view as any;
                    const file = pdfView.file;
                    if (file) {
                        const page = this.getPageNumber(firstLeaf.view);
                        this.activeFile = file;
                        this.activePage = page;
                        this.setupScrollListener(firstLeaf.view);
                        this.schedulePageUpdate(firstLeaf.view);
                    }
                }
            }
        } else {
            // No PDFs open in workspace
            this.activeFile = null;
            this.activePage = 0;
        }
    }
    
    private setupScrollListener(view: View) {
        const container = view.containerEl as HTMLElement & { _lexmaHasScrollListener?: boolean };
        if (container._lexmaHasScrollListener) {
            return;
        }
        
        container._lexmaHasScrollListener = true;
        
        // Listen to scroll events in capture phase to intercept internal container scroll updates
        this.registerDomEvent(container, 'scroll', () => {
            if (this.isTracking) {
                this.schedulePageUpdate(view);
            }
        }, true);
    }
    
    private schedulePageUpdate(view: View) {
        if (!this.isTracking) return;
        if (this.debounceTimer) {
            window.clearTimeout(this.debounceTimer);
        }
        
        this.debounceTimer = window.setTimeout(() => {
            (async () => {
                if (!this.isTracking) return;
                const pdfView = view as unknown as ObsidianPDFView;
                const file = pdfView.file;
                if (!file) return;
                
                const pageNumber = this.getPageNumber(view);
                
                if (this.activeFile?.path !== file.path || this.activePage !== pageNumber) {
                    this.activeFile = file;
                    this.activePage = pageNumber;
                    
                    const text = await this.getPageText(file, pageNumber);
                    if (this.onPageChange) {
                        this.onPageChange({
                            file: file.path,
                            page: pageNumber,
                            text: text
                        });
                    }
                }
            })().catch((err) => {
                console.error("Error in schedulePageUpdate timer callback:", err);
            });
        }, 300); // 300ms debounce prevents lag when scrolling quickly
    }
}

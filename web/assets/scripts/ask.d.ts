export function formatDocumentLocationLabel(
  sourceFile: string,
  pageNumbers: number[],
): string;

export interface AskEvidencePanelBounds {
  height: number;
  left: number;
  top: number;
  width: number;
}

export interface AskEvidencePanelViewport {
  height: number;
  width: number;
}

export interface AskEvidencePanelPlacement {
  left: number;
  maxHeight: number;
  top: number;
  width: number;
}

export function readAskEvidencePanelPlacement(
  triggerBounds: AskEvidencePanelBounds,
  panelBounds: Pick<AskEvidencePanelBounds, "height" | "width">,
  viewport: AskEvidencePanelViewport,
): AskEvidencePanelPlacement;

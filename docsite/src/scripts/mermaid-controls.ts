import svgPanZoom from "svg-pan-zoom";

// Adapted from Mostlylucid's Mermaid enhancement design.
// Export controls and export code are intentionally omitted.
// https://github.com/scottgal/mostlylucidweb/tree/main/mostlylucid-mermaid

type ControlAction = "fullscreen" | "zoomIn" | "zoomOut" | "reset" | "close";

interface DiagramController {
  diagram: HTMLPreElement;
  instance: SvgPanZoom.Instance;
  sourceSvg: SVGSVGElement;
  svg: SVGSVGElement;
  wrapper: HTMLDivElement;
  resizeObserver: ResizeObserver;
}

interface LightboxController {
  dialog: HTMLDialogElement;
  instance: SvgPanZoom.Instance;
  svg: SVGSVGElement;
  trigger: HTMLButtonElement;
}

interface PendingDiagram {
  observer: ResizeObserver;
  svg: SVGSVGElement;
}

const controllers = new Map<HTMLPreElement, DiagramController>();
const pendingDiagrams = new Map<HTMLPreElement, PendingDiagram>();
let lightboxController: LightboxController | null = null;
let enhancementFrame: number | null = null;

function createIcon(action: ControlAction): SVGSVGElement {
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("fill", "none");
  icon.setAttribute("viewBox", "0 0 24 24");

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  path.setAttribute("stroke-width", "2");

  switch (action) {
    case "fullscreen":
      path.setAttribute("d", "M8 3H3v5m13-5h5v5M8 21H3v-5m13 5h5v-5");
      break;
    case "zoomIn":
      path.setAttribute("d", "m21 21-4.35-4.35M11 8v6m-3-3h6m5 0a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z");
      break;
    case "zoomOut":
      path.setAttribute("d", "m21 21-4.35-4.35M8 11h6m5 0a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z");
      break;
    case "reset":
      path.setAttribute("d", "M4 4v5h5M5.5 16a8 8 0 1 0 .5-9l-2 2");
      break;
    case "close":
      path.setAttribute("d", "m6 6 12 12M18 6 6 18");
      break;
  }

  icon.append(path);
  return icon;
}

function createControlButton(action: ControlAction, label: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "mermaid-diagram-control";
  button.dataset.action = action;
  button.title = label;
  button.setAttribute("aria-label", label);
  button.append(createIcon(action));
  return button;
}

function createToolbar(isLightbox: boolean): HTMLDivElement {
  const toolbar = document.createElement("div");
  toolbar.className = "mermaid-diagram-controls not-content";
  toolbar.setAttribute("aria-label", "Mermaid diagram controls");
  toolbar.setAttribute("role", "toolbar");

  if (!isLightbox) {
    toolbar.append(createControlButton("fullscreen", "Maximize diagram"));
  }

  toolbar.append(createControlButton("zoomIn", "Zoom in"));
  toolbar.append(createControlButton("zoomOut", "Zoom out"));
  toolbar.append(createControlButton("reset", "Reset view"));

  if (isLightbox) {
    toolbar.append(createControlButton("close", "Close expanded diagram"));
  }

  return toolbar;
}

function ensureWrapper(diagram: HTMLPreElement): HTMLDivElement {
  const parent = diagram.parentElement;
  if (parent instanceof HTMLDivElement && parent.classList.contains("mermaid-diagram")) {
    parent.classList.add("not-content");
    return parent;
  }

  const wrapper = document.createElement("div");
  wrapper.className = "mermaid-diagram not-content";
  diagram.before(wrapper);
  wrapper.append(diagram);
  wrapper.append(createToolbar(false));
  return wrapper;
}

function initializePanZoom(svg: SVGSVGElement): SvgPanZoom.Instance {
  const instance = svgPanZoom(svg, {
    center: true,
    contain: false,
    controlIconsEnabled: false,
    dblClickZoomEnabled: false,
    eventsListenerElement: svg,
    fit: true,
    maxZoom: 10,
    minZoom: 0.25,
    mouseWheelZoomEnabled: false,
    panEnabled: true,
    preventMouseEventsDefault: false,
    zoomEnabled: true,
    zoomScaleSensitivity: 0.3,
  });

  return instance;
}

function fitController(controller: DiagramController): void {
  if (!hasPositiveSize(controller.svg)) {
    return;
  }

  controller.instance.resize();
  controller.instance.fit();
  controller.instance.center();
}

function scheduleInitialFit(controller: DiagramController): void {
  requestAnimationFrame(() => {
    if (controllers.get(controller.diagram) !== controller) {
      return;
    }

    fitController(controller);
  });
}

function destroyController(controller: DiagramController): void {
  controller.resizeObserver.disconnect();
  controllers.delete(controller.diagram);

  try {
    controller.instance.destroy();
  } catch (error) {
    console.warn("Failed to clean up a replaced Mermaid diagram.", error);
  }
}

function readViewBoxAspectRatio(svg: SVGSVGElement): number | null {
  const viewBox = svg.viewBox.baseVal;
  if (viewBox.width <= 0 || viewBox.height <= 0) {
    return null;
  }

  return viewBox.width / viewBox.height;
}

function preserveAspectRatio(svg: SVGSVGElement): void {
  const aspectRatio = readViewBoxAspectRatio(svg);
  if (aspectRatio === null) {
    return;
  }

  svg.style.aspectRatio = String(aspectRatio);
}

function hasPositiveSize(svg: SVGSVGElement): boolean {
  const bounds = svg.getBoundingClientRect();
  if (!Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) {
    return false;
  }

  return bounds.width > 0 && bounds.height > 0;
}

function clearPendingDiagram(diagram: HTMLPreElement): void {
  const pendingDiagram = pendingDiagrams.get(diagram);
  if (!pendingDiagram) {
    return;
  }

  pendingDiagram.observer.disconnect();
  pendingDiagrams.delete(diagram);
}

function waitForPositiveSize(diagram: HTMLPreElement, svg: SVGSVGElement): void {
  const pendingDiagram = pendingDiagrams.get(diagram);
  if (pendingDiagram?.svg === svg) {
    return;
  }

  clearPendingDiagram(diagram);
  const observer = new ResizeObserver(() => {
    if (!svg.isConnected || !hasPositiveSize(svg)) {
      return;
    }

    clearPendingDiagram(diagram);
    scheduleEnhancement();
  });

  pendingDiagrams.set(diagram, { observer, svg });
  observer.observe(svg);
}

function enhanceDiagram(diagram: HTMLPreElement): void {
  const svg = diagram.querySelector("svg");
  if (!(svg instanceof SVGSVGElement)) {
    return;
  }

  const existingController = controllers.get(diagram);
  if (existingController?.svg === svg) {
    return;
  }

  if (existingController) {
    destroyController(existingController);
  }

  preserveAspectRatio(svg);
  if (!hasPositiveSize(svg)) {
    waitForPositiveSize(diagram, svg);
    return;
  }

  clearPendingDiagram(diagram);
  const wrapper = ensureWrapper(diagram);
  const sourceSvg = svg.cloneNode(true) as SVGSVGElement;
  svg.style.maxWidth = "none";

  try {
    const instance = initializePanZoom(svg);
    const resizeObserver = new ResizeObserver(() => {
      if (hasPositiveSize(svg)) {
        instance.resize();
      }
    });
    const controller: DiagramController = {
      diagram,
      instance,
      resizeObserver,
      sourceSvg,
      svg,
      wrapper,
    };

    controllers.set(diagram, controller);
    resizeObserver.observe(wrapper);
    scheduleInitialFit(controller);
  } catch (error) {
    console.error("Failed to add Mermaid diagram controls.", error);
  }
}

function enhanceRenderedDiagrams(): void {
  for (const controller of controllers.values()) {
    if (!controller.diagram.isConnected) {
      destroyController(controller);
    }
  }

  for (const [diagram] of pendingDiagrams) {
    if (!diagram.isConnected) {
      clearPendingDiagram(diagram);
    }
  }

  const diagrams = document.querySelectorAll("pre.mermaid[data-processed]");
  for (const element of diagrams) {
    if (element instanceof HTMLPreElement) {
      try {
        enhanceDiagram(element);
      } catch (error) {
        console.error("Failed to enhance a Mermaid diagram.", error);
      }
    }
  }
}

function scheduleEnhancement(): void {
  if (enhancementFrame !== null) {
    return;
  }

  enhancementFrame = requestAnimationFrame(() => {
    enhancementFrame = null;
    enhanceRenderedDiagrams();
  });
}

function resetInstance(instance: SvgPanZoom.Instance, svg: SVGSVGElement): void {
  if (!hasPositiveSize(svg)) {
    return;
  }

  instance.resize();
  instance.reset();
  instance.fit();
  instance.center();
}

function closeLightbox(): void {
  if (!lightboxController) {
    return;
  }

  const controller = lightboxController;
  lightboxController = null;

  try {
    controller.instance.destroy();
  } catch (error) {
    console.warn("Failed to clean up the expanded Mermaid diagram.", error);
  }

  controller.dialog.close();
  controller.dialog.remove();
  document.body.classList.remove("mermaid-lightbox-open");
  controller.trigger.focus();
}

function handleLightboxCancel(event: Event): void {
  event.preventDefault();
  closeLightbox();
}

function handleLightboxBackdropClick(event: MouseEvent): void {
  if (event.target === lightboxController?.dialog) {
    closeLightbox();
  }
}

function openLightbox(controller: DiagramController, trigger: HTMLButtonElement): void {
  closeLightbox();

  const dialog = document.createElement("dialog");
  dialog.className = "mermaid-lightbox";
  dialog.setAttribute("aria-label", "Expanded Mermaid diagram");

  const stage = document.createElement("div");
  stage.className = "mermaid-lightbox-stage";
  const svg = controller.sourceSvg.cloneNode(true) as SVGSVGElement;
  svg.removeAttribute("height");
  svg.removeAttribute("width");
  svg.style.height = "100%";
  svg.style.maxWidth = "none";
  svg.style.width = "100%";
  stage.append(svg);
  dialog.append(stage, createToolbar(true));
  dialog.addEventListener("cancel", handleLightboxCancel);
  dialog.addEventListener("click", handleLightboxBackdropClick);
  document.body.append(dialog);
  document.body.classList.add("mermaid-lightbox-open");
  dialog.showModal();

  try {
    const instance = initializePanZoom(svg);
    lightboxController = { dialog, instance, svg, trigger };
    requestAnimationFrame(() => {
      if (lightboxController?.dialog !== dialog) {
        return;
      }

      instance.resize();
      instance.fit();
      instance.center();
      dialog.querySelector<HTMLButtonElement>('[data-action="close"]')?.focus();
    });
  } catch (error) {
    dialog.close();
    dialog.remove();
    document.body.classList.remove("mermaid-lightbox-open");
    console.error("Failed to maximize the Mermaid diagram.", error);
  }
}

function readControlButton(event: Event): HTMLButtonElement | null {
  if (!(event.target instanceof Element)) {
    return null;
  }

  const button = event.target.closest(".mermaid-diagram-control");
  if (!(button instanceof HTMLButtonElement)) {
    return null;
  }

  return button;
}

function readControlAction(button: HTMLButtonElement): ControlAction | null {
  switch (button.dataset.action) {
    case "fullscreen":
    case "zoomIn":
    case "zoomOut":
    case "reset":
    case "close":
      return button.dataset.action;
    default:
      return null;
  }
}

function readDiagramController(button: HTMLButtonElement): DiagramController | null {
  const wrapper = button.closest(".mermaid-diagram");
  const diagram = wrapper?.querySelector("pre.mermaid");
  if (!(diagram instanceof HTMLPreElement)) {
    return null;
  }

  return controllers.get(diagram) ?? null;
}

function handleControlClick(event: Event): void {
  const button = readControlButton(event);
  if (!button) {
    return;
  }

  const action = readControlAction(button);
  if (!action) {
    return;
  }

  if (button.closest(".mermaid-lightbox")) {
    if (!lightboxController) {
      return;
    }

    if (action === "close") {
      closeLightbox();
    } else if (action === "zoomIn") {
      lightboxController.instance.zoomIn();
    } else if (action === "zoomOut") {
      lightboxController.instance.zoomOut();
    } else if (action === "reset") {
      resetInstance(lightboxController.instance, lightboxController.svg);
    }

    return;
  }

  const controller = readDiagramController(button);
  if (!controller) {
    return;
  }

  if (action === "fullscreen") {
    openLightbox(controller, button);
  } else if (action === "zoomIn") {
    controller.instance.zoomIn();
  } else if (action === "zoomOut") {
    controller.instance.zoomOut();
  } else if (action === "reset") {
    resetInstance(controller.instance, controller.svg);
  }
}

function cleanupControllers(): void {
  closeLightbox();
  for (const controller of controllers.values()) {
    destroyController(controller);
  }

  for (const [diagram] of pendingDiagrams) {
    clearPendingDiagram(diagram);
  }
}

function startMermaidControls(): void {
  const observer = new MutationObserver(scheduleEnhancement);
  observer.observe(document.body, { childList: true, subtree: true });
  document.addEventListener("click", handleControlClick);
  document.addEventListener("astro:before-swap", cleanupControllers);
  document.addEventListener("astro:page-load", scheduleEnhancement);
  scheduleEnhancement();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", startMermaidControls, { once: true });
} else {
  startMermaidControls();
}

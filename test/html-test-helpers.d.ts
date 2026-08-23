export interface HtmlTestAttribute {
  name: string;
  value: string;
}

export interface HtmlTestElement {
  attrs: HtmlTestAttribute[];
  tagName: string;
}

export function findHtmlElementByAttribute(
  elements: readonly HtmlTestElement[],
  attributeName: string,
  attributeValue: string,
): HtmlTestElement;

export function findHtmlElementByTagName(
  elements: readonly HtmlTestElement[],
  tagName: string,
): HtmlTestElement;

export function findHtmlElementByText(
  elements: readonly HtmlTestElement[],
  tagName: string,
  text: string,
): HtmlTestElement;

export function htmlElementHasClass(
  element: HtmlTestElement,
  className: string,
): boolean;

export function readHtmlAttribute(
  element: HtmlTestElement | undefined,
  attributeName: string,
): string | null;

export function readHtmlDocumentText(
  elements: readonly HtmlTestElement[],
): string;

export function readHtmlElements(html: string): HtmlTestElement[];

export function readHtmlText(node: HtmlTestElement): string;

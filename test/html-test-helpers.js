import { parse } from "parse5";

export function readHtmlElements(html) {
  const elements = [];
  collectHtmlElements(parse(html), elements);
  return elements;
}

export function findHtmlElementByAttribute(
  elements,
  attributeName,
  attributeValue,
) {
  for (const element of elements) {
    if (readHtmlAttribute(element, attributeName) === attributeValue) {
      return element;
    }
  }
  throw new Error(
    `Could not find an element with ${attributeName}="${attributeValue}".`,
  );
}

export function findHtmlElementByText(elements, tagName, text) {
  for (const element of elements) {
    if (element.tagName === tagName && readHtmlText(element).trim() === text) {
      return element;
    }
  }
  throw new Error(`Could not find a ${tagName} element containing "${text}".`);
}

export function htmlElementHasClass(element, className) {
  const classNames = readHtmlAttribute(element, "class")?.split(/\s+/u) ?? [];
  return classNames.includes(className);
}

export function readHtmlAttribute(element, attributeName) {
  for (const attribute of element.attrs) {
    if (attribute.name === attributeName) {
      return attribute.value;
    }
  }
  return null;
}

export function readHtmlText(node) {
  if (node.nodeName === "#text") {
    return node.value;
  }
  let text = "";
  for (const child of node.childNodes ?? []) {
    text += readHtmlText(child);
  }
  if (node.content !== undefined) {
    text += readHtmlText(node.content);
  }
  return text;
}

function collectHtmlElements(node, elements) {
  if (typeof node.tagName === "string") {
    elements.push(node);
  }
  for (const child of node.childNodes ?? []) {
    collectHtmlElements(child, elements);
  }
  if (node.content !== undefined) {
    collectHtmlElements(node.content, elements);
  }
}

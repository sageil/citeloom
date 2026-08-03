export function focusTextArea(textArea) {
  if (!(textArea instanceof HTMLTextAreaElement) || textArea.disabled) {
    return;
  }
  textArea.focus({ preventScroll: true });
  const cursorPosition = textArea.value.length;
  textArea.setSelectionRange(cursorPosition, cursorPosition);
}

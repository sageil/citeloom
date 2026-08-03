import re


INLINE_OCR_ELEMENT = re.compile(
    r"^(title|sub_title|text|table|table_caption|figure|figure_caption|"
    r"image|image_caption|header|footer)\s+"
    r"\[\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*,\s*"
    r"-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*\]\s*(.*)$"
)


def normalize_vlm_generated_text(generated_text: str) -> str:
    """Convert inline OCR annotations to Markdown when that shape is present."""
    blocks: list[str] = []
    current_lines: list[str] = []
    matched_annotation = False
    pending_prefix = ""
    skip_current_block = False

    for line in generated_text.splitlines():
        match = INLINE_OCR_ELEMENT.match(line.strip())
        if match is None:
            if skip_current_block:
                continue
            content = line.strip()
            if content:
                current_lines.append(f"{pending_prefix}{content}")
                pending_prefix = ""
            continue

        append_block(blocks, current_lines)
        matched_annotation = True
        label = match.group(1)
        content = match.group(2).strip()
        pending_prefix = read_markdown_prefix(label)
        skip_current_block = label in {"figure", "image"} and not content
        if not content:
            continue
        current_lines.append(f"{pending_prefix}{content}")
        pending_prefix = ""

    if not matched_annotation:
        return generated_text

    append_block(blocks, current_lines)
    return "\n\n".join(blocks)


def append_block(blocks: list[str], lines: list[str]) -> None:
    block = "\n".join(lines).strip()
    if block:
        blocks.append(block)
    lines.clear()


def read_markdown_prefix(label: str) -> str:
    if label == "title":
        return "# "
    if label == "sub_title":
        return "## "
    return ""

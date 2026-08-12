export function buildCitationPresentation(citation) {
  if (citation.evidence.kind !== "table") {
    return citation;
  }
  const table = citation.evidence.table;
  const rows = tryBuildCitationTableRows(
    table.cells,
    table.rowCount,
    table.columnCount,
  );
  let bodyRows = [];
  let headerRows = [];
  let renderMode = "text";
  if (rows !== null) {
    bodyRows = rows.bodyRows;
    headerRows = rows.headerRows;
    renderMode = "grid";
  }
  return {
    ...citation,
    evidence: {
      ...citation.evidence,
      table: {
        ...table,
        bodyRows,
        headerRows,
        renderMode,
      },
    },
  };
}

export function buildCitationPresentations(citations) {
  const presentations = [];
  for (let index = 0; index < citations.length; index += 1) {
    presentations.push(buildCitationPresentation(citations[index]));
  }
  return presentations;
}

function tryBuildCitationTableRows(cells, rowCount, columnCount) {
  const rows = [];
  const occupiedColumnsByRow = [];
  let headerRowEnd = 0;
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    rows.push({ cells: [], key: `row-${rowIndex}` });
    occupiedColumnsByRow.push(
      Array.from({ length: columnCount }, () => false),
    );
  }
  for (let cellIndex = 0; cellIndex < cells.length; cellIndex += 1) {
    const cell = cells[cellIndex];
    if (
      cell.endColumn > columnCount
      || cell.endRow > rowCount
      || cell.endColumn - cell.startColumn !== cell.columnSpan
      || cell.endRow - cell.startRow !== cell.rowSpan
    ) {
      return null;
    }
    for (let rowIndex = cell.startRow; rowIndex < cell.endRow; rowIndex += 1) {
      const occupiedColumns = occupiedColumnsByRow[rowIndex];
      if (occupiedColumns === undefined) {
        return null;
      }
      for (
        let columnIndex = cell.startColumn;
        columnIndex < cell.endColumn;
        columnIndex += 1
      ) {
        if (occupiedColumns[columnIndex] !== false) {
          return null;
        }
        occupiedColumns[columnIndex] = true;
      }
    }
    const row = rows[cell.startRow];
    if (row === undefined) {
      return null;
    }
    row.cells.push({
      columnSpan: cell.columnSpan,
      key: `cell-${cell.startRow}-${cell.startColumn}`,
      rowHeader: cell.rowHeader || cell.rowSection,
      rowSpan: cell.rowSpan,
      startColumn: cell.startColumn,
      text: cell.text,
    });
    if (cell.columnHeader) {
      headerRowEnd = Math.max(headerRowEnd, cell.endRow);
    }
  }
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    const occupiedColumns = occupiedColumnsByRow[rowIndex];
    if (row === undefined || occupiedColumns === undefined) {
      return null;
    }
    for (
      let columnIndex = 0;
      columnIndex < occupiedColumns.length;
      columnIndex += 1
    ) {
      if (occupiedColumns[columnIndex] === false) {
        row.cells.push({
          columnSpan: 1,
          key: `placeholder-${rowIndex}-${columnIndex}`,
          rowHeader: false,
          rowSpan: 1,
          startColumn: columnIndex,
          text: "",
        });
      }
    }
    row.cells.sort((left, right) => left.startColumn - right.startColumn);
  }
  return {
    bodyRows: rows.slice(headerRowEnd),
    headerRows: rows.slice(0, headerRowEnd),
  };
}

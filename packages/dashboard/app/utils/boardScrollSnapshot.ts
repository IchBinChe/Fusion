export interface BoardScrollSnapshot {
  boardLeft: number;
  boardTop: number;
  columnTops: Record<string, number>;
}

function getBoardDocument(doc?: Document): Document | null {
  if (doc) return doc;
  return typeof document === "undefined" ? null : document;
}

/*
FNXC:BoardNavigation 2026-06-22-20:15:
Board-card task detail replaces the board instead of overlaying it. Capture horizontal board scroll and per-column vertical scroll before opening detail, then restore after Back to board remounts the board so users return to the same lane/card context.
*/
export function captureBoardScrollSnapshot(doc?: Document): BoardScrollSnapshot | null {
  const ownerDocument = getBoardDocument(doc);
  const board = ownerDocument?.getElementById("board") as HTMLElement | null;
  if (!board) return null;

  const columnTops: Record<string, number> = {};
  board.querySelectorAll<HTMLElement>(".column[data-column]").forEach((column) => {
    const columnId = column.dataset.column;
    const body = column.querySelector<HTMLElement>(".column-body");
    if (columnId && body) {
      columnTops[columnId] = body.scrollTop;
    }
  });

  return {
    boardLeft: board.scrollLeft,
    boardTop: board.scrollTop,
    columnTops,
  };
}

export function restoreBoardScrollSnapshot(snapshot: BoardScrollSnapshot | null, doc?: Document): boolean {
  if (!snapshot) return false;
  const ownerDocument = getBoardDocument(doc);
  const board = ownerDocument?.getElementById("board") as HTMLElement | null;
  if (!board) return false;

  board.scrollLeft = snapshot.boardLeft;
  board.scrollTop = snapshot.boardTop;
  board.querySelectorAll<HTMLElement>(".column[data-column]").forEach((column) => {
    const columnId = column.dataset.column;
    const body = column.querySelector<HTMLElement>(".column-body");
    if (columnId && body && Object.prototype.hasOwnProperty.call(snapshot.columnTops, columnId)) {
      body.scrollTop = snapshot.columnTops[columnId];
    }
  });

  return true;
}

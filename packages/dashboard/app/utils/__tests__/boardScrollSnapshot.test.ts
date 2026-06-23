import { describe, expect, it } from "vitest";
import { captureBoardScrollSnapshot, restoreBoardScrollSnapshot } from "../boardScrollSnapshot";

describe("boardScrollSnapshot", () => {
  it("round-trips board horizontal scroll and per-column vertical scroll", () => {
    document.body.innerHTML = `
      <main id="board">
        <section class="column" data-column="todo"><div class="column-body"></div></section>
        <section class="column" data-column="in-progress"><div class="column-body"></div></section>
      </main>
    `;
    const board = document.getElementById("board") as HTMLElement;
    const todoBody = document.querySelector('[data-column="todo"] .column-body') as HTMLElement;
    const activeBody = document.querySelector('[data-column="in-progress"] .column-body') as HTMLElement;

    board.scrollLeft = 240;
    board.scrollTop = 12;
    todoBody.scrollTop = 380;
    activeBody.scrollTop = 95;

    const snapshot = captureBoardScrollSnapshot();

    board.scrollLeft = 0;
    board.scrollTop = 0;
    todoBody.scrollTop = 0;
    activeBody.scrollTop = 0;

    expect(restoreBoardScrollSnapshot(snapshot)).toBe(true);
    expect(board.scrollLeft).toBe(240);
    expect(board.scrollTop).toBe(12);
    expect(todoBody.scrollTop).toBe(380);
    expect(activeBody.scrollTop).toBe(95);
  });

  it("returns false when the board is not mounted", () => {
    document.body.innerHTML = "";

    expect(captureBoardScrollSnapshot()).toBeNull();
    expect(restoreBoardScrollSnapshot({ boardLeft: 10, boardTop: 0, columnTops: {} })).toBe(false);
  });
});

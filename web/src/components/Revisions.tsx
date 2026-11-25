import { useState } from "react";
import { diffCards, fmtDate, STATUS_LABEL } from "../lib/deck";
import type { Deck } from "../types";

/** Edit history: every save keeps the previous version; any of them can be restored. */
export function Revisions({ deck, onRestore, busy }: { deck: Deck; onRestore: (index: number) => void; busy: boolean }) {
  const [open, setOpen] = useState<number | null>(null);
  if (deck.revisions.length === 0) return <p className="muted small">まだ編集履歴はありません（保存するたびに前の版が残ります）。</p>;
  return (
    <div className="revisions">
      {deck.revisions.map((r, i) => {
        // revisions[i] is the version before revisions[i-1] (or the current deck for i = 0)
        const after = i === 0 ? deck.cards : deck.revisions[i - 1]!.cards;
        const diff = diffCards(r.cards, after);
        return (
          <div key={i} className="rev">
            <div className="rev-head" onClick={() => setOpen(open === i ? null : i)}>
              <span>
                {fmtDate(r.at)} {r.by && <span className="muted">{r.by}</span>}
              </span>
              <span className="muted small">
                {r.cards.reduce((s, c) => s + c.count, 0)}枚 · {STATUS_LABEL[r.status]} · 次の版で{diff.length ? `${diff.length}種変更` : "カード変更なし"}
              </span>
            </div>
            {open === i && (
              <div className="rev-body">
                {r.name !== (i === 0 ? deck.name : deck.revisions[i - 1]!.name) && <div className="small">名前: {r.name}</div>}
                {diff.length > 0 && (
                  <ul className="diff small">
                    {diff.map((d) => (
                      <li key={`${d.zone}${d.name}`} className={d.after > d.before ? "plus" : "minus"}>
                        {d.name}: {d.before} → {d.after}
                      </li>
                    ))}
                  </ul>
                )}
                <button type="button" disabled={busy} onClick={() => confirm("この版の内容に戻しますか？（今の内容も履歴に残ります）") && onRestore(i)}>
                  この版に戻す
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

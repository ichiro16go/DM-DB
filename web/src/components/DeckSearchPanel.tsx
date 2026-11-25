import { useEffect, useState } from "react";
import { api } from "../api";
import { thumb } from "../lib/deck";
import { useDebounced } from "../lib/hooks";
import type { CardItem, DeckCard, Format, Zone } from "../types";
import { CivDots, RegBadge } from "./Card";

/**
 * Card search inside the deck builder. Accepts plain names or any query of the search language;
 * restricted to cards legal in the deck's format unless "全カード" is checked.
 */
export function DeckSearchPanel({
  format,
  cards,
  onAdd,
  onOpen,
}: {
  format: Format;
  cards: DeckCard[];
  onAdd: (zone: Zone, name: string) => void;
  onOpen: (id: number) => void;
}) {
  const [q, setQ] = useState("");
  const [all, setAll] = useState(false);
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<CardItem[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const dq = useDebounced(q, 300);

  useEffect(() => setPage(1), [dq, all, format]);
  useEffect(() => {
    if (!dq.trim()) {
      setItems([]);
      setTotal(0);
      return;
    }
    let live = true;
    const query = all ? dq : `(${dq}) f:${format}`;
    api.search({ q: query, page, pageSize: 30, unique: "cards", order: "name" }).then(
      (r) => {
        if (!live) return;
        setError(null);
        setItems((prev) => (page === 1 ? r.items : [...prev, ...r.items]));
        setTotal(r.total);
      },
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [dq, all, format, page]);

  const inDeck = (c: CardItem) => cards.filter((x) => x.name === c.name).reduce((s, x) => s + x.count, 0);

  return (
    <div className="deck-search">
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="カード名 / クエリ（例: kw:S・トリガー c:光 cost<=3）"
        spellCheck={false}
        autoFocus={typeof window !== "undefined" && window.innerWidth > 900}
      />
      <label className="small">
        <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> フォーマット外のカードも表示
      </label>
      {error && <div className="error small">{error}</div>}
      {!dq.trim() && <p className="muted small">名前の一部を入力すると候補が出ます。＋で追加、名前をクリックで詳細。</p>}
      {dq.trim() && !error && <div className="muted small">{total.toLocaleString()} 件</div>}
      <div className="search-rows">
        {items.map((c) => {
          const n = inDeck(c);
          return (
            <div key={c.id} className="search-row">
              {thumb(c.image) ? <img src={thumb(c.image)!} alt="" loading="lazy" /> : <span className="noimg-sm" />}
              <div className="info" onClick={() => onOpen(c.id)} title="詳細を表示">
                <div className="nm">
                  {c.name} <RegBadge regulation={c.regulation} />
                </div>
                <div className="small muted">
                  <CivDots civs={c.civs} /> {c.minCost ?? "-"} · {c.faces[0]?.type}
                  {c.zone !== "main" && <span className="badge">{c.zone === "gr" ? "GR" : "超次元"}</span>}
                </div>
              </div>
              {n > 0 && <span className="in-deck">{n}</span>}
              <button type="button" className="add" title="1枚追加" onClick={() => onAdd(c.startsInBattleZone ? "special" : c.zone, c.name)}>
                ＋
              </button>
            </div>
          );
        })}
      </div>
      {items.length < total && (
        <button type="button" className="more" onClick={() => setPage(page + 1)}>
          さらに表示（残り {total - items.length}）
        </button>
      )}
    </div>
  );
}

import { useState } from "react";
import { thumb, ZONE_LABEL, ZONES } from "../lib/deck";
import type { DeckAnalysis, DeckCard, ResolvedDeckCard, Zone } from "../types";
import { CivDots } from "./Card";

const key = (c: { zone: Zone; name: string }) => `${c.zone}\u0000${c.name}`;

/** Inline fix for a name the DB could not identify: pick a candidate or type the correct name. */
function FixName({ info, onRename }: { info: ResolvedDeckCard | undefined; onRename: (name: string) => void }) {
  const [v, setV] = useState("");
  return (
    <div className="fix-name">
      {info && info.candidates.length > 0 && (
        <select value="" onChange={(e) => e.target.value && onRename(e.target.value)}>
          <option value="">候補から選ぶ…</option>
          {info.candidates.slice(0, 12).map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      )}
      <input
        value={v}
        onChange={(e) => setV(e.target.value)}
        placeholder="正しいカード名を入力して Enter"
        onKeyDown={(e) => {
          if (e.key === "Enter" && v.trim()) {
            e.preventDefault();
            onRename(v.trim());
            setV("");
          }
        }}
      />
    </div>
  );
}

/**
 * The deck's cards by zone, sorted by cost. Each row: count stepper, zone move, remove; rows the
 * DB could not identify (or "?" from an unreadable photo) get an inline name fix.
 */
export function DeckList({
  cards,
  analysis,
  onChange,
  onOpen,
}: {
  cards: DeckCard[];
  analysis: DeckAnalysis | null;
  onChange: (cards: DeckCard[]) => void;
  onOpen: (id: number) => void;
}) {
  const info = new Map((analysis?.cards ?? []).map((c) => [key({ zone: c.zone, name: c.inputName }), c]));
  const setCount = (c: DeckCard, n: number) =>
    onChange(n <= 0 ? cards.filter((x) => x !== c) : cards.map((x) => (x === c ? { ...x, count: Math.min(40, n) } : x)));
  const move = (c: DeckCard, zone: Zone) => {
    const rest = cards.filter((x) => x !== c);
    const same = rest.find((x) => x.zone === zone && x.name === c.name);
    onChange(same ? rest.map((x) => (x === same ? { ...x, count: Math.min(40, x.count + c.count) } : x)) : [...rest, { ...c, zone }]);
  };
  const rename = (c: DeckCard, name: string) => {
    const rest = cards.filter((x) => x !== c);
    const same = rest.find((x) => x.zone === c.zone && x.name === name);
    onChange(same ? rest.map((x) => (x === same ? { ...x, count: Math.min(40, x.count + c.count) } : x)) : cards.map((x) => (x === c ? { ...x, name } : x)));
  };

  const zones = ZONES.filter((z) => z === "main" || cards.some((c) => c.zone === z));
  return (
    <div className="deck-list">
      {zones.map((z) => {
        const rows = cards
          .filter((c) => c.zone === z)
          .map((c) => ({ c, i: info.get(key(c)) }))
          .sort((a, b) => Number(!!a.i?.cardId) - Number(!!b.i?.cardId) || (a.i?.cost ?? 99) - (b.i?.cost ?? 99) || a.c.name.localeCompare(b.c.name, "ja"));
        const n = rows.reduce((s, r) => s + r.c.count, 0);
        return (
          <div key={z} className="zone">
            <div className="zone-head">
              {ZONE_LABEL[z]} <b>{n}</b>枚 <span className="muted small">{rows.length}種</span>
            </div>
            {rows.length === 0 && <p className="muted small">左の検索からカードを追加してください。</p>}
            {rows.map(({ c, i }) => {
              const unknown = analysis !== null && !i?.cardId;
              const guessed = i?.cardId && i.method && i.method !== "exact" && i.method !== "loose";
              return (
                <div key={key(c)} className={`deck-row ${unknown ? "unknown" : ""}`}>
                  {i?.image ? <img src={thumb(i.image)!} alt="" loading="lazy" onClick={() => i.cardId && onOpen(i.cardId)} /> : <span className="noimg-sm" />}
                  <span className="cost">{i?.cost ?? "?"}</span>
                  <div className="nm-wrap">
                    <div className="nm" onClick={() => i?.cardId && onOpen(i.cardId)}>
                      {i?.civs && <CivDots civs={i.civs} />} {c.name === "?" ? "（読み取れないカード）" : c.name}
                    </div>
                    {guessed && (
                      <div className="small warn-text" title="入力名と完全には一致しません">
                        「{c.name}」→ {i.name} と判定
                      </div>
                    )}
                    {unknown && <FixName info={i} onRename={(name) => rename(c, name)} />}
                  </div>
                  <span className="stepper">
                    <button type="button" onClick={() => setCount(c, c.count - 1)} aria-label="1枚減らす">
                      −
                    </button>
                    <b>{c.count}</b>
                    <button type="button" onClick={() => setCount(c, c.count + 1)} aria-label="1枚増やす">
                      ＋
                    </button>
                  </span>
                  <select value={c.zone} onChange={(e) => move(c, e.target.value as Zone)} title="ゾーンを移動">
                    {ZONES.map((zz) => (
                      <option key={zz} value={zz}>
                        {zz === "main" ? "メイン" : zz === "gr" ? "GR" : "超次元"}
                      </option>
                    ))}
                  </select>
                  <button type="button" className="remove" onClick={() => setCount(c, 0)} aria-label="削除" title="削除">
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

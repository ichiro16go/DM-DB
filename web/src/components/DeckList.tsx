import { useState } from "react";
import { civFill, ZONE_LABEL, zonesOf, ZONES } from "../../../src/deck/rules";
import { thumb } from "../lib/deck";
import type { DeckAnalysis, DeckCard, Format, ResolvedDeckCard, Zone } from "../types";

const key = (c: { zone: Zone; name: string }) => `${c.zone}\u0000${c.name}`;

/** Inline fix for a name the DB could not identify: pick a candidate or type the correct name. */
function FixName({ info, onRename }: { info: ResolvedDeckCard | undefined; onRename: (name: string) => void }) {
  const [v, setV] = useState("");
  return (
    <div className="fix-name">
      {info && info.candidates.length > 0 && (
        <select value="" onChange={(e) => e.target.value && onRename(e.target.value)} aria-label="候補から選ぶ">
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
        aria-label="正しいカード名"
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

/** Zones to show as tabs: the format's zones, plus any other zone that still holds cards. */
export const visibleZones = (format: Format, cards: DeckCard[]): Zone[] => {
  const own = zonesOf(format);
  return ZONES.filter((z) => own.includes(z) || cards.some((c) => c.zone === z));
};

export function ZoneTabs({
  zones,
  active,
  counts,
  onSelect,
  format,
}: {
  zones: Zone[];
  active: Zone;
  counts: Record<Zone, number>;
  onSelect: (z: Zone) => void;
  format: Format;
}) {
  const own = zonesOf(format);
  return (
    <div role="tablist" className="zone-tabs">
      {zones.map((z) => (
        <button
          key={z}
          type="button"
          role="tab"
          aria-selected={z === active}
          className={`${z === active ? "active" : ""} ${own.includes(z) ? "" : "foreign"}`}
          title={own.includes(z) ? undefined : "このフォーマットでは使えないゾーンです"}
          onClick={() => onSelect(z)}
        >
          {ZONE_LABEL[z]} <span className="n">{counts[z] ?? 0}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * Cards of one zone, sorted by cost. Each row: civ stripe, cost, thumbnail, name with any rule
 * warning for that card, count stepper, remove. Cards in the wrong zone get a one-tap move; names
 * the DB could not identify get an inline fix.
 */
export function DeckList({
  zone,
  cards,
  analysis,
  rowProblems,
  onChange,
  onOpen,
}: {
  zone: Zone;
  cards: DeckCard[];
  analysis: DeckAnalysis | null;
  rowProblems: Map<string, string[]>;
  onChange: (cards: DeckCard[]) => void;
  onOpen: (id: number) => void;
}) {
  const info = new Map((analysis?.cards ?? []).map((c) => [key({ zone: c.zone, name: c.inputName }), c]));
  const setCount = (c: DeckCard, n: number) =>
    onChange(n <= 0 ? cards.filter((x) => x !== c) : cards.map((x) => (x === c ? { ...x, count: Math.min(40, n) } : x)));
  const merge = (c: DeckCard, patch: Partial<DeckCard>) => {
    const next = { ...c, ...patch };
    const rest = cards.filter((x) => x !== c);
    const same = rest.find((x) => x.zone === next.zone && x.name === next.name);
    onChange(same ? rest.map((x) => (x === same ? { ...x, count: Math.min(40, x.count + c.count) } : x)) : cards.map((x) => (x === c ? next : x)));
  };

  const rows = cards
    .filter((c) => c.zone === zone)
    .map((c) => ({ c, i: info.get(key(c)) }))
    .sort((a, b) => Number(!!a.i?.cardId) - Number(!!b.i?.cardId) || (a.i?.cost ?? 99) - (b.i?.cost ?? 99) || a.c.name.localeCompare(b.c.name, "ja"));

  if (rows.length === 0)
    return (
      <div className="deck-list empty">
        <p className="muted">{ZONE_LABEL[zone]}にはまだカードがありません。右の検索からタップで追加できます。</p>
      </div>
    );

  return (
    <div className="deck-list">
      {rows.map(({ c, i }) => {
        const unknown = analysis !== null && !i?.cardId;
        const guessed = i?.cardId && i.method && i.method !== "exact" && i.method !== "loose";
        const misplaced = i?.homeZone && i.homeZone !== c.zone ? i.homeZone : null;
        // A misplaced card gets the one-tap move instead of the validator's zone message.
        const warns = ((i?.cardId ? rowProblems.get(i.name) : rowProblems.get(c.name)) ?? []).filter((w) => !misplaced || !/ゾーン|特殊枠/.test(w));
        const flagged = warns.length > 0 || unknown || !!misplaced;
        return (
          <div key={key(c)} className={`deck-row ${flagged ? "warn" : ""}`}>
            <span className="stripe" style={{ background: civFill(i?.civs ?? []) }} aria-hidden="true" />
            <span className="cost-gem">{i?.cost ?? "?"}</span>
            {i?.image ? (
              <img src={thumb(i.image)!} alt="" onClick={() => i.cardId && onOpen(i.cardId)} />
            ) : (
              <span className="noimg-sm" style={{ background: civFill(i?.civs ?? []) }} />
            )}
            <div className="nm-wrap">
              <button type="button" className="nm" onClick={() => i?.cardId && onOpen(i.cardId)} disabled={!i?.cardId}>
                {c.name === "?" ? "（読み取れないカード）" : c.name}
              </button>
              {i?.type && <div className="type">{i.type}</div>}
              {guessed && (
                <div className="row-warn" title="入力名と完全には一致しません">
                  「{c.name}」→ {i.name} と判定
                </div>
              )}
              {warns.map((w, k) => (
                <div key={k} className="row-warn">
                  ⚠ {w}
                </div>
              ))}
              {misplaced && (
                <div className="row-warn">
                  ⚠ {ZONE_LABEL[misplaced]}のカードです{" "}
                  <button type="button" className="link" onClick={() => merge(c, { zone: misplaced })}>
                    {ZONE_LABEL[misplaced]}へ移動
                  </button>
                </div>
              )}
              {unknown && <FixName info={i} onRename={(name) => merge(c, { name })} />}
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
            <button type="button" className="remove" onClick={() => setCount(c, 0)} aria-label="削除" title="削除">
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}

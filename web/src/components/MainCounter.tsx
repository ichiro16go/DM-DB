import { FORMAT_ZONES } from "../../../src/deck/rules";

/** The always-visible "36 / 40" main-deck counter: green when the deck is exactly the required size. */
export function MainCounter({ n, compact = false }: { n: number; compact?: boolean }) {
  const need = FORMAT_ZONES.original.main!.exact!;
  const state = n === need ? "ok" : n > need ? "over" : "under";
  return (
    <span className={`main-counter ${state} ${compact ? "compact" : ""}`} aria-label={`メインデッキ ${n}枚 / ${need}枚`} role="status">
      {!compact && <span className="lbl">メイン</span>}
      <b>{n}</b>
      <span className="of">/ {need}</span>
    </span>
  );
}

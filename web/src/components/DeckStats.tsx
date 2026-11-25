import { CIV_COLOR, CIV_ORDER, civFill } from "../../../src/deck/rules";
import type { DeckAnalysis } from "../types";

/**
 * Problems that are not about one card (zone sizes, premium combos …). Per-card problems are
 * shown on the card's row instead; here only their number.
 */
export function ProblemSummary({ analysis, rowCount }: { analysis: DeckAnalysis | null; rowCount: number }) {
  if (!analysis) return null;
  const general = analysis.report.problems.filter((p) => !p.card && !/40枚ちょうど/.test(p.message));
  const ok = analysis.report.valid && analysis.counts.unknown === 0;
  if (ok) return <div className="problem-summary ok">✓ 構築ルールOK</div>;
  return (
    <div className="problem-summary ng" role="status">
      {general.map((p, i) => (
        <div key={i}>⚠ {p.message}</div>
      ))}
      {rowCount > 0 && <div>⚠ 警告のあるカードが {rowCount} 種類あります（各行に表示）</div>}
    </div>
  );
}

const pct = (n: number, total: number) => (total ? `${Math.round((n / total) * 100)}%` : "-");

/** Cost curve, civilization balance (multi-colored counted separately) and card types of the main deck. */
export function AnalysisPanels({ analysis }: { analysis: DeckAnalysis | null }) {
  if (!analysis) return null;
  const main = analysis.cards.filter((c) => c.zone === "main" && c.cardId);
  const total = main.reduce((s, c) => s + c.count, 0);

  const curve = new Map<string, number>();
  for (const c of main) {
    const k = c.cost === null ? "-" : c.cost >= 10 ? "10+" : String(c.cost);
    curve.set(k, (curve.get(k) ?? 0) + c.count);
  }
  const keys = [...curve.keys()].sort((a, b) => (parseInt(a) || 99) - (parseInt(b) || 99));
  const maxN = Math.max(1, ...curve.values());

  const mono = new Map<string, number>();
  let multi = 0;
  const multiCivs = new Set<string>();
  for (const c of main) {
    const civs = c.civs.length ? c.civs : ["無色"];
    if (civs.length > 1) {
      multi += c.count;
      civs.forEach((x) => multiCivs.add(x));
    } else mono.set(civs[0]!, (mono.get(civs[0]!) ?? 0) + c.count);
  }
  const monoList = [...mono].sort((a, b) => CIV_ORDER.indexOf(a[0]) - CIV_ORDER.indexOf(b[0]));
  const multiList = CIV_ORDER.filter((c) => multiCivs.has(c));

  const types = new Map<string, number>();
  for (const c of main) if (c.type) types.set(c.type, (types.get(c.type) ?? 0) + c.count);
  const typeList = [...types].sort((a, b) => b[1] - a[1]);

  return (
    <div className="analysis">
      <div className="panel-sm">
        <div className="panel-title">コストカーブ（メイン）</div>
        <div className="curve" role="img" aria-label={keys.map((k) => `コスト${k}: ${curve.get(k)}枚`).join("、")}>
          {keys.map((k) => (
            <div key={k} className="col" title={`コスト${k}: ${curve.get(k)}枚`}>
              <span className="n">{curve.get(k)}</span>
              <span className="bar-v" style={{ height: `${(curve.get(k)! / maxN) * 56}px` }} />
              <span className="k">{k}</span>
            </div>
          ))}
          {keys.length === 0 && <span className="muted small">-</span>}
        </div>
      </div>
      <div className="panel-sm">
        <div className="panel-title">文明</div>
        <div className="civ-bar" aria-hidden="true">
          {monoList.map(([c, n]) => (
            <span key={c} style={{ flex: n, background: CIV_COLOR[c] }} />
          ))}
          {multi > 0 && <span style={{ flex: multi, background: civFill(multiList) }} />}
        </div>
        <ul className="stat-list">
          {monoList.map(([c, n]) => (
            <li key={c}>
              <span className="dot" style={{ background: CIV_COLOR[c] }} />
              {c} <b>{n}</b> <span className="muted">（{pct(n, total)}）</span>
            </li>
          ))}
          {multi > 0 && (
            <li>
              <span className="dot" style={{ background: civFill(multiList) }} />
              多色 <b>{multi}</b> <span className="muted">（{multiList.join("/")}）</span>
            </li>
          )}
          {total === 0 && <li className="muted">-</li>}
        </ul>
      </div>
      <div className="panel-sm">
        <div className="panel-title">種類</div>
        <ul className="stat-list">
          {typeList.map(([t, n]) => (
            <li key={t}>
              {t} <b>{n}</b> <span className="muted">（{pct(n, total)}）</span>
            </li>
          ))}
          {total === 0 && <li className="muted">-</li>}
        </ul>
      </div>
    </div>
  );
}

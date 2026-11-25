import type { DeckAnalysis, Format } from "../types";

const CIV_ORDER = ["光", "水", "闇", "火", "自然", "ゼロ", "無色"];

/** Construction check, card counts, civilization and cost distribution of the current list. */
export function DeckStats({ analysis, format, pending }: { analysis: DeckAnalysis | null; format: Format; pending: boolean }) {
  if (!analysis) return <div className="panel muted">集計中…</div>;
  const { counts, report } = analysis;
  const curve = Object.entries(report.costCurve).sort((a, b) => (parseInt(a[0]) || 99) - (parseInt(b[0]) || 99));
  const maxN = Math.max(1, ...curve.map((x) => x[1]));
  const types = new Map<string, number>();
  for (const c of analysis.cards) if (c.zone === "main" && c.type) types.set(c.type, (types.get(c.type) ?? 0) + c.count);
  const civs = Object.entries(report.civs).sort((a, b) => CIV_ORDER.indexOf(a[0]) - CIV_ORDER.indexOf(b[0]));
  const errors = report.problems.filter((p) => p.severity === "error");
  const warnings = report.problems.filter((p) => p.severity === "warning");
  const ok = report.valid && counts.unknown === 0;

  return (
    <div className={`panel deck-stats ${pending ? "pending" : ""}`}>
      <div className={`verdict ${ok ? "ok" : "ng"}`}>
        {ok ? "✓ 構築ルールOK" : counts.unknown ? "△ 特定できないカードあり" : "✗ 構築ルール違反あり"}
        <span className="muted small">（{format === "original" ? "オリジナル" : "アドバンス"}）</span>
      </div>
      <div className="counts">
        <span className={counts.main === 40 ? "ok" : "ng"}>
          メイン <b>{counts.main}</b>/40
        </span>
        {(format === "advance" || counts.hyperspatial > 0) && (
          <span className={counts.hyperspatial <= 8 ? "" : "ng"}>
            超次元 <b>{counts.hyperspatial}</b>/8
          </span>
        )}
        {(format === "advance" || counts.gr > 0) && (
          <span className={counts.gr === 0 || counts.gr === 12 ? "" : "ng"}>
            超GR <b>{counts.gr}</b>/12
          </span>
        )}
        {counts.unknown > 0 && (
          <span className="ng">
            不明 <b>{counts.unknown}</b>
          </span>
        )}
      </div>
      {[...errors, ...warnings].map((p, i) => (
        <div key={i} className={`problem ${p.severity}`}>
          {p.message}
        </div>
      ))}
      {analysis.problems.map((p, i) => (
        <div key={`r${i}`} className="problem warning">
          {p}
        </div>
      ))}

      <div className="stat-cols">
        <div>
          <div className="section-title">文明（枚数）</div>
          <div>
            {civs.length === 0 && <span className="muted small">-</span>}
            {civs.map(([c, n]) => (
              <span key={c} className="badge civ-badge">
                <span className={`dot cb-${c}`} />
                {c} {n}
              </span>
            ))}
          </div>
          <div className="section-title">種類（メイン）</div>
          <div className="small">
            {[...types].map(([t, n]) => (
              <div key={t}>
                {t} <b>{n}</b>
              </div>
            ))}
          </div>
        </div>
        <div>
          <div className="section-title">コストカーブ（メイン）</div>
          <div className="curve" role="img" aria-label={curve.map(([k, n]) => `コスト${k}: ${n}枚`).join("、")}>
            {curve.map(([k, n]) => (
              <div key={k} className="col" title={`コスト${k}: ${n}枚`}>
                <span className="n">{n}</span>
                <span className="bar-v" style={{ height: `${(n / maxN) * 64}px` }} />
                <span className="k">{k}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { FORMAT_LABEL, STATUS_LABEL } from "../lib/deck";
import { useAsync } from "../lib/hooks";
import type { Format, RankingRow } from "../types";

export const fmtPeriod = (a: string, b: string) => `${a.replace(/-/g, "/")} 〜 ${b.slice(5).replace(/-/g, "/")}`;

export function FormatTabs({ format, onChange }: { format: Format; onChange: (f: Format) => void }) {
  return (
    <span className="seg">
      {(["original", "advance"] as Format[]).map((f) => (
        <button key={f} type="button" className={f === format ? "active" : ""} onClick={() => onChange(f)}>
          {FORMAT_LABEL[f]}
        </button>
      ))}
    </span>
  );
}

function Delta({ row }: { row: RankingRow }) {
  if (!row.prev) return <span className="delta new">NEW</span>;
  const d = Math.round((row.share - row.prev.share) * 10) / 10;
  const r = row.prev.rank - row.rank;
  return (
    <span className="delta-wrap" title={`前週 ${row.prev.rank}位・${row.prev.share}%（${row.prev.count}回）`}>
      <span className={`delta ${r > 0 ? "up" : r < 0 ? "down" : ""}`}>{r > 0 ? `▲${r}` : r < 0 ? `▼${-r}` : "－"}</span>
      <span className="muted small">
        {d > 0 ? "+" : ""}
        {d.toFixed(1)}pt
      </span>
    </span>
  );
}

export function StatusPill({ status }: { status: keyof typeof STATUS_LABEL }) {
  return <span className={`status ${status}`}>{STATUS_LABEL[status]}</span>;
}

/** 環境: weekly archetype ranking (updated automatically from 田園補完計画) with the registered deck lists. */
export function MetaPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const format: Format = params.get("format") === "advance" ? "advance" : "original";
  const week = params.get("week");
  const { data, error, loading } = useAsync(() => api.ranking(format, week), [format, week]);
  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) v ? next.set(k, v) : next.delete(k);
    setParams(next);
  };
  const max = Math.max(1, ...(data?.rows.map((r) => r.share) ?? [1]));
  const detail = (name: string) => `/meta/archetype?${new URLSearchParams({ format, name, ...(week ? { week } : {}) })}`;

  return (
    <section className="meta-page">
      <div className="page-head">
        <h1>環境デッキ</h1>
        <FormatTabs format={format} onChange={(f) => set({ format: f, week: null })} />
        {data && (
          <select value={week ?? data.snapshot.periodStart} onChange={(e) => set({ week: e.target.value === data.weeks[0] ? null : e.target.value })}>
            {data.weeks.map((w, i) => (
              <option key={w} value={w}>
                {w.replace(/-/g, "/")} の週{i === 0 ? "（最新）" : ""}
              </option>
            ))}
          </select>
        )}
      </div>
      {error && (
        <div className="error">{error.message.includes("no snapshot") ? "この形式の環境データがまだありません（更新ジョブの実行待ち）。" : error.message}</div>
      )}
      {loading && !data && <p className="muted">読み込み中…</p>}
      {data && (
        <>
          <div className="panel snapshot-info">
            <div>
              <b>{fmtPeriod(data.snapshot.periodStart, data.snapshot.periodEnd)}</b> の {FORMAT_LABEL[format]} CS 入賞 <b>{data.snapshot.sampleSize}</b> デッキ
              {data.snapshot.latestSet && <span className="muted">（最新弾: {data.snapshot.latestSet}）</span>}
            </div>
            <div className="small muted">
              出典:{" "}
              <a href={data.snapshot.url} target="_blank" rel="noopener">
                田園補完計画「{data.snapshot.title}」
              </a>
              {data.previous && (
                <>
                  {" "}
                  ／ 前週比は {fmtPeriod(data.previous.periodStart, data.previous.periodEnd)}（{data.previous.sampleSize}デッキ）と比較
                </>
              )}
            </div>
            <div className="small muted">
              分布は毎日自動で取り込み（週次ランキングは月曜夜に公開）。デッキリストは自動更新されないので、誤りがあればデッキ画面から修正できます。
            </div>
          </div>

          <table className="data ranking">
            <thead>
              <tr>
                <th className="num">順位</th>
                <th>前週比</th>
                <th>デッキタイプ</th>
                <th className="num">入賞</th>
                <th style={{ width: "28%" }}>シェア</th>
                <th className="num" title="入賞結果（上位4位）を取得できたCS数 / うちデッキ画像あり">
                  結果/画像
                </th>
                <th>デッキリスト</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.name} className="clickable" onClick={() => navigate(detail(r.name))}>
                  <td className="num">{r.rank}</td>
                  <td>
                    <Delta row={r} />
                  </td>
                  <td>
                    <Link to={detail(r.name)} onClick={(e) => e.stopPropagation()}>
                      <b>{r.name}</b>
                    </Link>
                    {r.note && <div className="muted small">{r.note}</div>}
                  </td>
                  <td className="num">{r.count}</td>
                  <td>
                    <div className="sharebar" title={`${r.share}%（${r.count}/${data.snapshot.sampleSize}）`}>
                      <span style={{ width: `${(r.share / max) * 100}%` }} />
                      <em>{r.share.toFixed(1)}%</em>
                    </div>
                  </td>
                  <td className="num small">
                    {r.placements}/{r.withImages}
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    {r.decks.length === 0 ? (
                      <span className="muted small">未登録</span>
                    ) : (
                      <span className="deck-links">
                        {r.decks.slice(0, 2).map((d) => (
                          <Link key={d.id} to={`/decks/${d.id}`} title={d.name}>
                            {d.source?.rank ?? "リスト"}
                            <StatusPill status={d.status} />
                          </Link>
                        ))}
                        {r.decks.length > 2 && <span className="muted small">他{r.decks.length - 2}</span>}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.singletons.length > 0 && (
            <div className="panel small">
              <b>1回のみ入賞（{data.singletonShare != null ? `${data.singletonShare}%` : `${data.singletons.length}デッキ`}）</b>
              <div className="muted">{data.singletons.join(" ／ ")}</div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

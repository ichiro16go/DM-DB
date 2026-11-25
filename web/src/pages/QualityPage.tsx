import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { useAsync } from "../lib/hooks";

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export function QualityPage() {
  const navigate = useNavigate();
  const { data, error } = useAsync(() => api.quality(), []);
  if (error) return <div className="error">{error.message}</div>;
  if (!data) return <p className="muted">読み込み中…</p>;
  const rows = data.keywordAgreement.filter((k) => k.official + k.parsed > 0).sort((a, b) => b.official - a.official);
  const tp = rows.reduce((s, k) => s + k.both, 0);
  const o = rows.reduce((s, k) => s + k.official, 0);
  const p = rows.reduce((s, k) => s + k.parsed, 0);
  const go = (q: string) => navigate(`/?${new URLSearchParams({ q })}`);
  return (
    <section>
      <div className="panel">
        <strong>キーワード抽出の精度（公式「特殊能力」検索との一致）</strong>
        <p className="muted small">公式サイトの特殊能力フィルタの結果を正解として、テキストから抽出したキーワード（自身が持つもの）と比較しています。</p>
        <p>
          適合率 <b>{p ? pct(tp / p) : "-"}</b> ／ 再現率 <b>{o ? pct(tp / o) : "-"}</b>（公式 {o.toLocaleString()} 件・抽出 {p.toLocaleString()} 件・一致{" "}
          {tp.toLocaleString()} 件）
        </p>
        <table className="data">
          <thead>
            <tr>
              <th>キーワード</th>
              <th className="num">公式</th>
              <th className="num">抽出</th>
              <th className="num">一致</th>
              <th className="num">適合率</th>
              <th className="num">再現率</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((k) => (
              <tr key={k.keyword}>
                <td>
                  <a
                    href="#"
                    title="公式にあり抽出漏れのカードを検索"
                    onClick={(e) => {
                      e.preventDefault();
                      go(`okw:${k.keyword} -kw:${k.keyword}`);
                    }}
                  >
                    {k.keyword}
                  </a>
                </td>
                <td className="num">{k.official}</td>
                <td className="num">{k.parsed}</td>
                <td className="num">{k.both}</td>
                <td className="num">{pct(k.precision)}</td>
                <td className="num">{pct(k.recall)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="panel">
        <strong>データ品質の記録</strong>
        <table className="data">
          <tbody>
            {data.issues.map((i) => (
              <tr key={i.kind}>
                <td>{i.kind}</td>
                <td className="num">{i.n}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

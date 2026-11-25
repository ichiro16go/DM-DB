import { Link } from "react-router-dom";
import { useCardMeta } from "../lib/cardMeta";

const EXAMPLES = [
  "kw:ブロッカー (c:光 or c:水) cost<=3 pow>=2000",
  "kw:パワーアタッカー>=2000 -kw:スレイヤー",
  "kw:ジャストダイバー kw:S・トリガー",
  "(kw:ジャストダイバー or kw:マッハファイター) c<=水闇",
  "kw:ブレイカー breaks>=3 cost<=6",
  "grant:スピードアタッカー race:ドラゴン",
  "tag:removal_destroy is:spell cost<=4 kw:S・トリガー f:original",
  "illust:Shishizaru unique:prints",
  "set:DM26-RP1 rarity:SR",
];

export function HelpPage() {
  const meta = useCardMeta();
  return (
    <section>
      <div className="panel">
        <strong>クエリ構文</strong>
        <ul>
          <li>
            スペース区切りは AND。<code>or</code>（または <code>|</code>）で OR、<code>-</code> または <code>not</code> で否定、<code>( )</code> でグループ化。
          </li>
          <li>
            演算子: <code>:</code>（含む/一致） <code>=</code>（完全一致） <code>!=</code> <code>&lt;</code> <code>&lt;=</code> <code>&gt;</code>{" "}
            <code>&gt;=</code>
          </li>
          <li>
            フィールドなしの語はカード名検索。空白を含む値は <code>"…"</code>、正規表現は <code>/…/</code>（name, text）。
          </li>
          <li>
            並び・単位: <code>order:cost</code> <code>dir:asc</code> <code>unique:prints</code>
          </li>
        </ul>
        <strong>例（クリックで検索）</strong>
        <ul>
          {EXAMPLES.map((q) => (
            <li key={q}>
              <Link to={`/?${new URLSearchParams({ q })}`}>
                <code>{q}</code>
              </Link>
            </li>
          ))}
        </ul>
      </div>
      <div className="panel">
        <table className="data help-table">
          <thead>
            <tr>
              <th>フィールド</th>
              <th>説明</th>
              <th>例</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(meta?.fields ?? {}).map(([k, f]) => (
              <tr key={k}>
                <td>{f.names.join(", ")}</td>
                <td>{f.description}</td>
                <td>
                  <code>{f.example}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
